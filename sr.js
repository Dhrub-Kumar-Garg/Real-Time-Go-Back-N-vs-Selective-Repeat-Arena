/**
 * sr.js  –  Selective Repeat protocol simulator (Phase 3: Loss & Recovery)
 * -------------------------------------------------------------------------
 * Implements strict, textbook-correct Selective Repeat sliding-window flow control:
 *
 * SR Protocol Rules:
 *  • Sender:
 *      - Maintains sendBase, nextSeq, windowSize.
 *      - Sends while nextSeq < sendBase + windowSize.
 *      - Maintains an INDEPENDENT timer for EACH unACKed packet in flight.
 *      - Starts individual timer when packet is sent / retransmitted.
 *      - On individual ACK(n): marks ONLY packet n as acked and stops its timer.
 *        If n == sendBase, advances sendBase to the next unACKed packet (slides over
 *        any already-ACKed packets ahead). Sends new packets that fit the window.
 *      - On TIMEOUT of packet n: retransmits ONLY packet n (amber, RETX tag) and restarts
 *        its timer. Never retransmits any other packet.
 *      - Ignores duplicate ACKs for already-ACKed packets.
 *  • Receiver:
 *      - Receiver window: [rcvBase .. rcvBase + windowSize - 1].
 *      - Accepts ANY packet within its window.
 *      - If seq is inside the window: sends individual ACK(seq). If not already buffered,
 *        stores it in the Receive Buffer slot (purple, "buffered" state).
 *      - If seq == rcvBase: delivers seq and all consecutive buffered packets after it in
 *        order, flushes buffer slots to the delivered strip, and advances rcvBase past them.
 *      - If seq is in [rcvBase - windowSize .. rcvBase - 1] (already delivered, re-sent
 *        because previous ACK was lost): re-sends individual ACK(seq), does not buffer or re-deliver.
 *      - Otherwise: ignores out-of-window packet.
 *  • Click-to-Drop Interaction:
 *      - Both DATA and ACK packets in flight are clickable to drop.
 *      - Dropped packets burst with "✕ LOST", are removed from DOM and in-flight lists,
 *        and increment "Packets lost" stat.
 */

(function (global) {
  'use strict';

  /* Shorthand alias for Engine exports */
  const get = () => global.Engine;

  /* =========================================================
   * PROTOCOL STATE
   * ========================================================= */
  let state = null;

  function createInitialState() {
    const cfg = get().SimConfig;
    const total = cfg.totalPackets;

    // Per-packet sender records: seq -> { seq, state, timerRunning, timerDeadline, timerStartTime, retxCount }
    const records = {};
    for (let i = 0; i < total; i++) {
      records[i] = {
        seq: i,
        state: 'unsent',        // 'unsent' | 'sent' | 'retransmit' | 'acked'
        timerRunning: false,
        timerDeadline: null,
        timerStartTime: null,
        retxCount: 0,
      };
    }

    return {
      // Sender window
      sendBase: 0,             // oldest unACKed sequence number
      nextSeq: 0,              // next sequence number to send initially
      windowSize: cfg.windowSize,
      lastSendTime: -999,      // simulation timestamp of last packet injection
      records,                 // per-packet tracking records
      retransmitQueue: [],     // FIFO queue of packet sequence numbers requiring retransmission

      // Active in-flight Packet objects: seq -> Packet
      packets: {},

      // Active in-flight ACK Packet objects
      acks: [],

      // Receiver state
      rcvBase: 0,              // oldest sequence number expected by receiver
      recvBuffer: new Map(),   // out-of-order packets held in receiver buffer (seq -> true)
      deliveredSet: new Set(), // set of all sequence numbers delivered to upper layer

      // Stats
      stats: {
        sent: 0,               // total transmissions (initial + retransmissions)
        retransmissions: 0,    // count of retransmitted packets
        acksReceived: 0,       // valid individual ACKs received
        timeouts: 0,           // individual packet timeouts
        lost: 0,               // packets/ACKs dropped by user
        delivered: 0,          // unique packets delivered
      },

      // Status flags
      done: false,
      container: null,
    };
  }

  /* =========================================================
   * DOM REFERENCES
   * ========================================================= */
  let dom = {
    senderBox: null,
    senderWindow: null,
    toast: null,
    channel: null,
    bufferArray: null,
    rcvWinEl: null,
    deliveredStrip: null,
    statsEls: {},
    logEl: null,
  };

  let toastTimeoutId = null;

  /* =========================================================
   * INIT
   * ========================================================= */
  function init(container) {
    state = createInitialState();
    state.container = container;
    _buildDOM(container);
    _renderWindowCells();
    _renderBuffer();
    _updateStats();
  }

  function _buildDOM(container) {
    dom.senderBox     = container.querySelector('#sr-sender-box') || container.querySelector('.sender-box');
    dom.senderWindow  = container.querySelector('.sender-window');
    dom.toast         = container.querySelector('#sr-toast');
    dom.channel       = container.querySelector('.channel');
    dom.bufferArray   = container.querySelector('.buffer-array');
    dom.rcvWinEl      = container.querySelector('#sr-rcv-win');
    dom.deliveredStrip= container.querySelector('.delivered-strip');
    dom.logEl         = container.querySelector('.arena-log');

    ['sent', 'retransmissions', 'acks', 'timeouts', 'lost', 'efficiency'].forEach(key => {
      dom.statsEls[key] = container.querySelector(`.stat-${key}`);
    });
  }

  /* =========================================================
   * TOAST NOTIFICATION HELPER
   * ========================================================= */
  function _showToast(message, durationMs = 2800) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.classList.remove('hidden');

    clearTimeout(toastTimeoutId);
    toastTimeoutId = setTimeout(() => {
      if (dom.toast) dom.toast.classList.add('hidden');
    }, durationMs);
  }

  /* =========================================================
   * EVENT LOGGING HELPER
   * Types: 'send', 'retx', 'ack', 'dupack', 'lost', 'buffered', 'deliver', 'timeout', 'info'
   * ========================================================= */
  function _log(message, type = 'info') {
    get().EventBus.emit('sr:log', { message, type });

    if (!dom.logEl) return;
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = `t=${get().fmt1(get().SimClock.simTime)}s`;

    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = message;

    entry.appendChild(time);
    entry.appendChild(msg);
    dom.logEl.appendChild(entry);
    dom.logEl.scrollTop = dom.logEl.scrollHeight;
  }

  /* =========================================================
   * LIVE STATS UPDATE
   * ========================================================= */
  function _updateStats() {
    if (!state) return;
    const s = state.stats;
    const total = s.sent;
    const unique = s.delivered;
    const eff = total > 0 ? ((unique / total) * 100).toFixed(1) + '%' : '–';

    const vals = {
      sent: s.sent,
      retransmissions: s.retransmissions,
      acks: s.acksReceived,
      timeouts: s.timeouts,
      lost: s.lost,
      efficiency: eff,
    };

    Object.entries(vals).forEach(([key, val]) => {
      if (dom.statsEls[key]) dom.statsEls[key].textContent = val;
    });

    get().EventBus.emit('sr:stat', vals);
  }

  /* =========================================================
   * SENDER WINDOW CELLS RENDERER
   * Shows sequence cells 0..N with individual packet state:
   *   wc-queued      – not yet sent
   *   wc-inflight    – sent, unACKed in flight
   *   wc-retransmit  – timed out, queued or resending
   *   wc-acked       – individual ACK received (turns green!)
   *   wc-window      – inside active sender window bracket
   * Each cell contains an independent timer progress bar.
   * ========================================================= */
  function _renderWindowCells() {
    if (!dom.senderWindow || !state) return;
    const cfg = get().SimConfig;
    const total = cfg.totalPackets;

    // Check if we need to rebuild the cells list
    if (dom.senderWindow.children.length !== total) {
      dom.senderWindow.innerHTML = '';
      for (let i = 0; i < total; i++) {
        const cell = document.createElement('div');
        cell.className = 'window-cell';
        cell.dataset.seq = i;

        const numSpan = document.createElement('span');
        numSpan.className = 'cell-num';
        numSpan.textContent = i;
        cell.appendChild(numSpan);

        const timerBar = document.createElement('div');
        timerBar.className = 'cell-timer-bar';
        const timerProgress = document.createElement('div');
        timerProgress.className = 'cell-timer-progress';
        timerProgress.style.width = '0%';
        timerBar.appendChild(timerProgress);
        cell.appendChild(timerBar);

        dom.senderWindow.appendChild(cell);
      }
    }

    // Update classes on each cell
    for (let i = 0; i < total; i++) {
      const cell = dom.senderWindow.children[i];
      if (!cell) continue;

      const rec = state.records[i];
      const isQueuedForRetx = state.retransmitQueue.includes(i);

      let stateClass = 'wc-queued';
      if (!rec || rec.state === 'unsent') {
        stateClass = 'wc-queued';
      } else if (rec.state === 'acked') {
        stateClass = 'wc-acked';
      } else if (isQueuedForRetx || rec.state === 'retransmit') {
        stateClass = 'wc-retransmit';
      } else if (rec.state === 'sent') {
        stateClass = 'wc-inflight';
      }

      cell.className = `window-cell ${stateClass}`;

      // Window bracket [sendBase .. sendBase + windowSize - 1]
      const inWindow = (i >= state.sendBase && i < state.sendBase + state.windowSize);
      if (inWindow && i < total) {
        cell.classList.add('wc-window');
      }
    }
  }

  /* =========================================================
   * PER-CELL MINI TIMER PROGRESS UPDATER
   * Runs every frame to smoothly drain individual timers.
   * ========================================================= */
  function _updateCellTimers(simTime) {
    if (!dom.senderWindow || !state) return;
    const cfg = get().SimConfig;
    const total = cfg.totalPackets;
    const duration = cfg.timeoutDuration;

    for (let i = 0; i < total; i++) {
      const cell = dom.senderWindow.children[i];
      if (!cell) continue;

      const progressEl = cell.querySelector('.cell-timer-progress');
      if (!progressEl) continue;

      const rec = state.records[i];
      if (rec && rec.timerRunning && rec.state !== 'acked' && rec.timerDeadline !== null) {
        const remaining = Math.max(0, rec.timerDeadline - simTime);
        const frac = get().clamp(remaining / duration, 0, 1);
        progressEl.style.width = `${(frac * 100).toFixed(1)}%`;

        if (frac > 0.4) {
          progressEl.className = 'cell-timer-progress';
        } else if (frac > 0.15) {
          progressEl.className = 'cell-timer-progress timer-amber';
        } else {
          progressEl.className = 'cell-timer-progress timer-red';
        }
      } else {
        progressEl.style.width = '0%';
        progressEl.className = 'cell-timer-progress';
      }
    }
  }

  /* =========================================================
   * SR RECEIVER BUFFER RENDERER
   * Shows every slot in the receive window [rcvBase .. rcvBase + W - 1].
   * Out-of-order arrivals fill their slot (purple), while missing gaps
   * remain dashed and empty so the missing packet is obvious.
   * ========================================================= */
  function _renderBuffer() {
    if (!dom.bufferArray || !state) return;
    dom.bufferArray.innerHTML = '';

    const cfg = get().SimConfig;
    const wSize = state.windowSize || cfg.windowSize;

    for (let i = 0; i < wSize; i++) {
      const slot = document.createElement('div');
      slot.className = 'buffer-slot';
      const seq = state.rcvBase + i;
      slot.dataset.seq = seq;

      if (seq < cfg.totalPackets) {
        if (state.recvBuffer.has(seq)) {
          slot.classList.add('buf-filled');
          slot.textContent = seq;
          slot.title = `Buffered: seq ${seq}`;
        } else {
          slot.classList.add('buf-empty');
          slot.textContent = seq;
          slot.title = `Empty slot: waiting for seq ${seq}`;
        }
      } else {
        slot.classList.add('buf-empty');
        slot.textContent = '–';
        slot.title = 'Beyond total packet range';
      }

      dom.bufferArray.appendChild(slot);
    }

    if (dom.rcvWinEl) {
      const end = Math.min(cfg.totalPackets - 1, state.rcvBase + wSize - 1);
      dom.rcvWinEl.textContent = `[${state.rcvBase}..${Math.max(state.rcvBase, end)}]`;
    }
  }

  /* =========================================================
   * PACKET POSITION CALCULATOR
   * Progress t ∈ [0, 1] based on simulation seconds elapsed.
   * ========================================================= */
  function _packetProgress(pkt, simTime) {
    const cfg = get().SimConfig;
    const delay = pkt.kind === 'data' ? cfg.propagationDelay : cfg.ackDelay;
    const elapsed = simTime - pkt.sendTime;
    return get().clamp(elapsed / delay, 0, 1);
  }

  /* =========================================================
   * SEND NEW DATA PACKET
   * ========================================================= */
  function _sendPacket(seq, simTime) {
    const { Packet } = get();
    const pkt = new Packet(seq, 'data', simTime);
    state.packets[seq] = pkt;

    const el = document.createElement('div');
    el.className = 'packet-el pkt-data';
    el.textContent = seq;
    el.dataset.seq = seq;
    el.dataset.kind = 'data';
    el.dataset.protocol = 'sr';
    el.title = `DATA[${seq}] – Click to drop`;

    // Click-to-drop interaction (generous 36px+ hit target)
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      dropPacket(seq, 'data');
    });

    pkt.element = el;

    // Top transmission lane (Data →)
    const vertOffset = 14 + (seq % 2) * 6;
    el.style.top = vertOffset + 'px';
    dom.channel.appendChild(el);

    // Update per-packet record and start its independent timer
    const rec = state.records[seq];
    rec.state = 'sent';
    rec.timerRunning = true;
    rec.timerStartTime = simTime;
    rec.timerDeadline = simTime + get().SimConfig.timeoutDuration;

    state.stats.sent++;
    _log(`[SEND] Sent DATA[${seq}]`, 'send');
    _updateStats();
    _renderWindowCells();
  }

  /* =========================================================
   * RETRANSMIT DATA PACKET (Selective Repeat recovery)
   * Resends ONLY the single timed-out packet.
   * ========================================================= */
  function _retransmitPacket(seq, simTime) {
    const { Packet } = get();

    // Clean up any stale DOM element if still in channel
    if (state.packets[seq] && state.packets[seq].element) {
      state.packets[seq].element.remove();
    }

    const pkt = new Packet(seq, 'data', simTime);
    pkt.isRetransmit = true;
    const rec = state.records[seq];
    rec.retxCount++;
    pkt.retransmitCount = rec.retxCount;
    state.packets[seq] = pkt;

    const el = document.createElement('div');
    el.className = 'packet-el pkt-data pkt-retransmit';
    el.innerHTML = `${seq}<span class="retx-badge">RETX</span>`;
    el.dataset.seq = seq;
    el.dataset.kind = 'data';
    el.dataset.protocol = 'sr';
    el.title = `DATA[${seq}] (Retransmission) – Click to drop`;

    // Click-to-drop interaction
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      dropPacket(seq, 'data');
    });

    pkt.element = el;

    // Top transmission lane
    const vertOffset = 14 + (seq % 2) * 6;
    el.style.top = vertOffset + 'px';
    dom.channel.appendChild(el);

    // Restart this packet's independent timer from the moment of re-transmission
    rec.state = 'sent';
    rec.timerRunning = true;
    rec.timerStartTime = simTime;
    rec.timerDeadline = simTime + get().SimConfig.timeoutDuration;

    state.stats.sent++;
    state.stats.retransmissions++;
    _log(`[RETX] Resent DATA[${seq}] (Selective Repeat recovery)`, 'retx');
    _updateStats();
    _renderWindowCells();
  }

  /* =========================================================
   * SEND INDIVIDUAL ACK
   * In SR, ACK(n) acknowledges ONLY packet n.
   * ========================================================= */
  function _sendAck(seq, simTime, isDuplicate = false) {
    const { Packet } = get();
    const ack = new Packet(seq, 'ack', simTime);
    state.acks.push(ack);

    const el = document.createElement('div');
    el.className = 'packet-el pkt-ack';
    el.textContent = seq;
    el.dataset.seq = seq;
    el.dataset.kind = 'ack';
    el.dataset.protocol = 'sr';
    el.title = `${isDuplicate ? 'Duplicate ' : ''}Individual ACK[${seq}] – Click to drop`;

    // Click-to-drop interaction on ACKs
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      dropAck(ack);
    });

    ack.element = el;

    // Bottom return lane (← ACK)
    const vertOffset = 64 + (seq % 2) * 6;
    el.style.top = vertOffset + 'px';
    dom.channel.appendChild(el);

    if (isDuplicate) {
      _log(`[DUP-ACK] Sent individual ACK[${seq}] (re-acknowledgement)`, 'dupack');
    } else {
      _log(`[ACK] Sent individual ACK[${seq}]`, 'ack');
    }
  }

  /* =========================================================
   * TIMEOUT HANDLER (Individual packet timeout)
   * ========================================================= */
  function _handleTimeout(seq, simTime) {
    state.stats.timeouts++;
    const rec = state.records[seq];

    _log(`[TIMEOUT] Timer expired for packet ${seq} – SR retransmitting ONLY packet ${seq}`, 'timeout');
    _showToast(`⚠️ TIMEOUT on packet ${seq} — resending ONLY packet ${seq}`);

    // Amber pulse on SR sender box
    if (dom.senderBox) {
      dom.senderBox.classList.add('sender-pulse-timeout');
      setTimeout(() => {
        if (dom.senderBox) dom.senderBox.classList.remove('sender-pulse-timeout');
      }, 800);
    }

    // Amber pulse on this specific cell
    if (dom.senderWindow && dom.senderWindow.children[seq]) {
      const cell = dom.senderWindow.children[seq];
      cell.classList.add('cell-pulse-timeout');
      setTimeout(() => cell.classList.remove('cell-pulse-timeout'), 800);
    }

    // Queue ONLY this packet for retransmission
    if (!state.retransmitQueue.includes(seq)) {
      state.retransmitQueue.push(seq);
    }
    rec.state = 'retransmit';

    // Restart timer for seq
    rec.timerStartTime = simTime;
    rec.timerDeadline = simTime + get().SimConfig.timeoutDuration;

    _renderWindowCells();
    _updateStats();
  }

  /* =========================================================
   * CLICK-TO-DROP INTERACTION
   * Shared visual mechanic via Engine.dropPacketVisual
   * ========================================================= */
  function dropPacket(seq, kind = 'data') {
    const pkt = state && state.packets[seq];
    if (!pkt || pkt.state !== 'in-flight' || pkt.dropped) return;

    pkt.dropped = true;
    pkt.state = 'dropped';
    state.stats.lost++;
    _updateStats();

    _log(`[LOST] Packet DATA[${seq}] dropped in transit!`, 'lost');

    const el = pkt.element;
    pkt.element = null;
    if (el) {
      get().dropPacketVisual(el, 'LOST');
    }
  }

  function dropAck(ack) {
    if (!ack || ack.state !== 'ack-flight' || ack.dropped) return;

    ack.dropped = true;
    ack.state = 'ack-dropped';
    state.stats.lost++;
    _updateStats();

    _log(`[LOST] Individual ACK[${ack.seq}] dropped in transit! (Sender will time out on packet ${ack.seq})`, 'lost');

    const el = ack.element;
    ack.element = null;
    if (el) {
      get().dropPacketVisual(el, 'LOST');
    }
  }

  /* =========================================================
   * DELIVERED STRIP
   * ========================================================= */
  function _addToDeliveredStrip(seq) {
    if (!dom.deliveredStrip) return;
    const chip = document.createElement('div');
    chip.className = 'delivered-chip';
    chip.textContent = seq;
    dom.deliveredStrip.appendChild(chip);
  }

  /* =========================================================
   * DELIVER IN-ORDER PREFIX & FLUSH RECEIVER BUFFER
   * Delivers consecutive buffered packets starting from rcvBase.
   * ========================================================= */
  function _deliverInOrderPrefix(triggerSeq, simTime) {
    const deliveredSeqs = [];

    while (state.recvBuffer.has(state.rcvBase)) {
      const s = state.rcvBase;
      state.recvBuffer.delete(s);
      state.deliveredSet.add(s);
      state.stats.delivered++;
      deliveredSeqs.push(s);
      _addToDeliveredStrip(s);
      _log(`[DELIVER] Delivered DATA[${s}] to upper layer ✓`, 'deliver');
      state.rcvBase++;
    }

    if (deliveredSeqs.length > 0) {
      // Toast notification for buffer flush
      if (deliveredSeqs.length > 1) {
        _showToast(`📦 Packet ${triggerSeq} arrived — delivered ${deliveredSeqs.join(', ')} in order`);
      } else {
        _showToast(`📦 Packet ${triggerSeq} arrived — delivered ${triggerSeq} in order`);
      }

      // Visual animation: mark buffer slots flushing
      if (dom.bufferArray) {
        deliveredSeqs.forEach(seq => {
          const slot = dom.bufferArray.querySelector(`[data-seq="${seq}"]`);
          if (slot) slot.classList.add('buf-flushing');
        });
      }

      // Re-render buffer slots to reflect new rcvBase
      setTimeout(() => {
        if (state && !state.done) {
          _renderBuffer();
        }
      }, 350);
    } else {
      _renderBuffer();
    }
  }

  /* =========================================================
   * FINISH
   * ========================================================= */
  function _finish(simTime) {
    if (state.done) return;
    state.done = true;
    _log(`✅ Transfer complete! Total sent: ${state.stats.sent}, Retransmissions: ${state.stats.retransmissions}`, 'success');
    _updateStats();
    get().EventBus.emit('sr:done', { stats: state.stats });

    const overlay = state.container ? state.container.querySelector('.done-overlay') : null;
    if (overlay) overlay.classList.remove('hidden');
  }

  /* =========================================================
   * TICK LOOP (Driven by SimClock requestAnimationFrame)
   * ========================================================= */
  function _tick(simTime, deltaS) {
    if (!state || state.done) return;

    const cfg = get().SimConfig;

    /* ---- 1. Update Per-Cell Mini Timer Bars ---- */
    _updateCellTimers(simTime);

    /* ---- 2. Check Independent Timers for Each In-Flight Packet ---- */
    for (let i = 0; i < cfg.totalPackets; i++) {
      const rec = state.records[i];
      if (rec && rec.timerRunning && rec.state !== 'acked' && rec.timerDeadline !== null) {
        if (simTime >= rec.timerDeadline) {
          _handleTimeout(i, simTime);
        }
      }
    }

    /* ---- 3. Inject Packets Across Channel (Spacing: txDelay) ---- */
    const canInject = (simTime >= state.lastSendTime + cfg.txDelay);

    if (canInject) {
      // Priority A: Pending selective retransmissions
      if (state.retransmitQueue.length > 0) {
        let rSeq = state.retransmitQueue.shift();
        // Skip if this packet was ACKed while waiting in queue
        while (rSeq !== undefined && state.records[rSeq] && state.records[rSeq].state === 'acked' && state.retransmitQueue.length > 0) {
          rSeq = state.retransmitQueue.shift();
        }
        if (rSeq !== undefined && state.records[rSeq] && state.records[rSeq].state !== 'acked') {
          _retransmitPacket(rSeq, simTime);
          state.lastSendTime = simTime;
        }
      }
      // Priority B: New transmissions within sender window (nextSeq < sendBase + windowSize)
      else if (
        state.nextSeq < cfg.totalPackets &&
        state.nextSeq < state.sendBase + state.windowSize
      ) {
        _sendPacket(state.nextSeq, simTime);
        state.lastSendTime = simTime;
        state.nextSeq++;
      }
    }

    /* ---- 4. Animate DATA Packets in Flight (Left → Right) ---- */
    const channelWidth = dom.channel ? dom.channel.clientWidth : 800;
    const packetW = 36;

    Object.values(state.packets).forEach(pkt => {
      if (pkt.state !== 'in-flight' || pkt.dropped || !pkt.element) return;

      const t = _packetProgress(pkt, simTime);
      const xPx = get().lerp(0, channelWidth - packetW, get().easeInOut(t));
      pkt.element.style.left = xPx + 'px';

      /* ---- Arrival at Receiver ---- */
      if (t >= 1) {
        pkt.state = 'delivered';
        pkt.arrivalTime = simTime;

        const el = pkt.element;
        pkt.element = null;

        const seq = pkt.seq;
        const rcvWinEnd = state.rcvBase + state.windowSize;

        // CASE 1: Inside receiver window [rcvBase .. rcvBase + windowSize - 1]
        if (seq >= state.rcvBase && seq < rcvWinEnd) {
          // Send individual ACK for this sequence number
          _sendAck(seq, simTime, false);

          if (!state.recvBuffer.has(seq)) {
            state.recvBuffer.set(seq, true);

            if (seq === state.rcvBase) {
              // Gap is filled! Deliver contiguous in-order prefix
              _deliverInOrderPrefix(seq, simTime);
            } else {
              // Out-of-order packet: buffer it and leave preceding gap empty
              _log(`[BUFFERED] Received DATA[${seq}] out-of-order – buffered in slot ${seq} (waiting for ${state.rcvBase})`, 'buffered');
              _renderBuffer();
            }
          }
        }
        // CASE 2: Inside [rcvBase - windowSize .. rcvBase - 1] (already delivered)
        else if (seq < state.rcvBase || state.deliveredSet.has(seq)) {
          // Sender timed out because our previous ACK was lost; re-ACK without re-delivering
          _log(`[DUP-ACK] Received DATA[${seq}] (already delivered) – re-sending ACK[${seq}]`, 'dupack');
          _sendAck(seq, simTime, true);
        }
        // CASE 3: Outside receiver window
        else {
          _log(`[DISCARD] Received DATA[${seq}] – outside receiver window [${state.rcvBase}..${rcvWinEnd - 1}], discarded`, 'warn');
        }

        if (el) {
          el.classList.add('pkt-arrived');
          setTimeout(() => el && el.remove(), 400);
        }
      }
    });

    /* ---- 5. Animate ACK Packets in Flight (Right → Left) ---- */
    state.acks.forEach(ack => {
      if (ack.state !== 'ack-flight' || ack.dropped || !ack.element) return;

      const t = _packetProgress(ack, simTime);
      const xPx = get().lerp(channelWidth - packetW, 0, get().easeInOut(t));
      ack.element.style.left = xPx + 'px';

      /* ---- Arrival at Sender ---- */
      if (t >= 1) {
        ack.state = 'ack-arrived';
        ack.arrivalTime = simTime;

        const ackEl = ack.element;
        ack.element = null;

        const ackedSeq = ack.seq;
        const rec = state.records[ackedSeq];

        if (rec) {
          if (rec.state === 'acked') {
            // Duplicate ACK for an already ACKed packet -> ignore
            _log(`[DUP-ACK] Received duplicate ACK[${ackedSeq}] – already ACKed, ignored`, 'dupack');
          } else {
            // INDIVIDUAL ACK: Mark ONLY this packet as acked and stop its timer
            rec.state = 'acked';
            rec.timerRunning = false;
            rec.timerDeadline = null;
            rec.timerStartTime = null;

            // Remove from retransmit queue if queued
            state.retransmitQueue = state.retransmitQueue.filter(s => s !== ackedSeq);

            state.stats.acksReceived++;
            _log(`[ACK] Received ACK[${ackedSeq}] – marked packet ${ackedSeq} as ACKed`, 'ack');

            // Slide sendBase forward past all consecutive already-ACKed packets
            const oldBase = state.sendBase;
            while (
              state.sendBase < cfg.totalPackets &&
              state.records[state.sendBase] &&
              state.records[state.sendBase].state === 'acked'
            ) {
              state.sendBase++;
            }

            if (state.sendBase > oldBase) {
              _log(`[WINDOW] Sender base advanced from ${oldBase} to ${state.sendBase}`, 'info');
            }

            _renderWindowCells();
            _updateStats();

            // Check if all packets delivered
            if (state.sendBase >= cfg.totalPackets) {
              _finish(simTime);
            }
          }
        }

        if (ackEl) {
          ackEl.classList.add('pkt-arrived');
          setTimeout(() => ackEl && ackEl.remove(), 300);
        }
      }
    });
  }

  /* =========================================================
   * PUBLIC PROTOCOL INTERFACE
   * ========================================================= */
  let _unsubscribeClock = null;

  function start() {
    if (!state) return;
    if (!_unsubscribeClock) {
      _unsubscribeClock = get().SimClock.subscribe(_tick);
    }
  }

  function pause() {
    // SimClock pause freezes simTime, which automatically halts per-packet timers
  }

  function reset() {
    clearTimeout(toastTimeoutId);

    if (_unsubscribeClock) {
      _unsubscribeClock();
      _unsubscribeClock = null;
    }

    if (state && state.container) {
      const channel = state.container.querySelector('.channel');
      if (channel) {
        channel.querySelectorAll('.packet-el').forEach(el => el.remove());
      }
      const strip = state.container.querySelector('.delivered-strip');
      if (strip) strip.innerHTML = '';
      const log = state.container.querySelector('.arena-log');
      if (log) log.innerHTML = '';
      const overlay = state.container.querySelector('.done-overlay');
      if (overlay) overlay.classList.add('hidden');
      if (dom.toast) dom.toast.classList.add('hidden');
      if (dom.senderBox) dom.senderBox.classList.remove('sender-pulse-timeout');
    }

    const container = state ? state.container : null;
    state = createInitialState();
    if (container) {
      state.container = container;
      _buildDOM(container);
      _renderWindowCells();
      _renderBuffer();
      _updateStats();
    }
  }

  function setWindowSize(n) {
    if (state) {
      state.windowSize = n;
      _renderWindowCells();
      _renderBuffer();
    }
  }

  function setSpeed(x) {
    get().SimConfig.speed = x;
  }

  /**
   * dropPacket(seq, kind)
   * Public hook to drop in-flight data packet or ACK by sequence number.
   */
  function dropPacketExternal(seq, kind = 'data') {
    if (kind === 'data') {
      dropPacket(seq, 'data');
    } else {
      const inFlightAck = state && state.acks.find(a => a.seq === seq && a.state === 'ack-flight' && !a.dropped);
      if (inFlightAck) {
        dropAck(inFlightAck);
      }
    }
  }

  global.SR = {
    init,
    start,
    pause,
    reset,
    setWindowSize,
    setSpeed,
    dropPacket: dropPacketExternal,
  };

})(window);
