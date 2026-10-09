/**
 * gbn.js  –  Go-Back-N protocol simulator (Phase 2: Packet Loss & Recovery)
 * ------------------------------------------------------------------------
 * Implements strict, textbook-correct Go-Back-N sliding-window flow control:
 *
 * GBN Protocol Rules:
 *  • Sender:
 *      - Maintains base, nextSeq, windowSize.
 *      - Sends while nextSeq < base + windowSize.
 *      - Maintains ONE timer for the oldest unACKed packet (base).
 *      - Starts timer when base is sent; restarts when base advances (if still
 *        unACKed packets); stops when base == nextSeq.
 *      - On TIMEOUT: retransmits ALL packets in current window [base..nextSeq-1],
 *        in order, and restarts timer. New packets cannot be sent until these are resent.
 *  • Receiver:
 *      - Maintains expectedSeq. Accepts ONLY in-order packets.
 *      - When expectedSeq arrives: delivers to upper layer, expectedSeq++, sends cumulative ACK.
 *      - When out-of-order packet arrives: DISCARDS it visibly and re-sends cumulative
 *        ACK for the last in-order delivered packet (expectedSeq - 1).
 *  • Click-to-Drop Interaction:
 *      - In-flight DATA and ACK packets are clickable to simulate loss.
 *      - Dropped packets burst with "✕ LOST" and never reach destination.
 *      - Dropping ACKs proves cumulative ACK resilience.
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
    return {
      // Sender window
      base: 0,                 // oldest unACKed sequence number
      nextSeq: 0,              // next sequence number to send
      windowSize: cfg.windowSize,
      lastSendTime: -999,      // simulation timestamp of last packet injection
      retransmitQueue: [],     // sequence numbers queued for retransmission on timeout

      // Single logical timer for the oldest unACKed packet (base)
      timerRunning: false,
      timerDeadline: null,     // simTime deadline when timer expires
      timerStartTime: null,    // simTime when current timer started/restarted
      timerBase: 0,            // sequence number the active timer is protecting

      // Packets lifecycle map: seq -> Packet
      packets: {},

      // ACK packets in flight (array of Packet objects)
      acks: [],

      // Receiver state
      expectedSeq: 0,          // next in-order sequence expected by receiver

      // Stats
      stats: {
        sent: 0,               // total transmissions (first + retransmissions)
        retransmissions: 0,    // count of retransmissions
        acksReceived: 0,       // valid cumulative ACKs received
        timeouts: 0,           // timeout events triggered
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
    timerFill: null,
    toast: null,
    discardAlert: null,
    channel: null,
    expectedSeqEl: null,
    deliveredStrip: null,
    statsEls: {},
    logEl: null,
  };

  let toastTimeoutId = null;
  let discardAlertTimeoutId = null;

  /* =========================================================
   * INIT
   * ========================================================= */
  function init(container) {
    state = createInitialState();
    state.container = container;
    _buildDOM(container);
    _renderWindowCells();
    _updateStats();
    _updateTimerGauge(0);
  }

  function _buildDOM(container) {
    dom.senderBox     = container.querySelector('#gbn-sender-box') || container.querySelector('.sender-box');
    dom.senderWindow  = container.querySelector('.sender-window');
    dom.timerFill     = container.querySelector('#gbn-timer-fill');
    dom.toast         = container.querySelector('#gbn-toast');
    dom.discardAlert  = container.querySelector('#gbn-discard-alert');
    dom.channel       = container.querySelector('.channel');
    dom.expectedSeqEl = container.querySelector('.expected-seq-value');
    dom.deliveredStrip= container.querySelector('.delivered-strip');
    dom.logEl         = container.querySelector('.arena-log');

    ['sent', 'retransmissions', 'acks', 'timeouts', 'lost', 'efficiency'].forEach(key => {
      dom.statsEls[key] = container.querySelector(`.stat-${key}`);
    });
  }

  /* =========================================================
   * VISUAL HELPERS: TOAST & DISCARD ALERT
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

  function _showDiscardAlert(seq, expected, durationMs = 1800) {
    if (!dom.discardAlert) return;
    dom.discardAlert.textContent = `Out of order DATA[${seq}] (expected ${expected}) — Discarded!`;
    dom.discardAlert.classList.remove('hidden');

    clearTimeout(discardAlertTimeoutId);
    discardAlertTimeoutId = setTimeout(() => {
      if (dom.discardAlert) dom.discardAlert.classList.add('hidden');
    }, durationMs);
  }

  /* =========================================================
   * SENDER WINDOW BAR RENDERER
   * Shows sequence cells 0..N with bracket and color-coded state:
   *   wc-queued      – not yet sent
   *   wc-inflight    – sent, unACKed in flight
   *   wc-retransmit  – queued / resending due to timeout
   *   wc-acked       – cumulative ACK received
   *   wc-window      – inside active window bracket
   * ========================================================= */
  function _renderWindowCells() {
    if (!dom.senderWindow) return;
    const cfg = get().SimConfig;
    const total = cfg.totalPackets;

    dom.senderWindow.innerHTML = '';

    for (let i = 0; i < total; i++) {
      const cell = document.createElement('div');
      cell.className = 'window-cell';
      cell.textContent = i;
      cell.dataset.seq = i;

      const pkt = state.packets[i];
      const isQueuedForRetx = state.retransmitQueue.includes(i);

      if (!pkt) {
        cell.classList.add('wc-queued');
      } else if (pkt.state === 'acked') {
        cell.classList.add('wc-acked');
      } else if (isQueuedForRetx || pkt.state === 'retransmit') {
        cell.classList.add('wc-retransmit');
      } else if (pkt.state === 'in-flight' || pkt.state === 'delivered') {
        cell.classList.add('wc-inflight');
      } else {
        cell.classList.add('wc-queued');
      }

      // Highlight active sender window bracket [base .. base + windowSize - 1]
      const inWindow = i >= state.base && i < state.base + state.windowSize;
      if (inWindow && i < total) {
        cell.classList.add('wc-window');
      }

      dom.senderWindow.appendChild(cell);
    }
  }

  /* =========================================================
   * TIMER IMPLEMENTATION (Kurose & Ross GBN specification)
   * ========================================================= */
  function _startTimer(simTime) {
    if (!state.timerRunning) {
      state.timerRunning = true;
      state.timerStartTime = simTime;
      state.timerDeadline = simTime + get().SimConfig.timeoutDuration;
      state.timerBase = state.base;
    }
  }

  function _restartTimer(simTime) {
    state.timerRunning = true;
    state.timerStartTime = simTime;
    state.timerDeadline = simTime + get().SimConfig.timeoutDuration;
    state.timerBase = state.base;
  }

  function _stopTimer() {
    state.timerRunning = false;
    state.timerDeadline = null;
    state.timerStartTime = null;
  }

  function _updateTimerGauge(simTime) {
    if (!dom.timerFill) return;

    if (!state || !state.timerRunning || state.timerDeadline === null) {
      dom.timerFill.style.width = '0%';
      dom.timerFill.className = 'timer-bar-fill';
      return;
    }

    const duration = get().SimConfig.timeoutDuration;
    const remaining = Math.max(0, state.timerDeadline - simTime);
    const fraction = get().clamp(remaining / duration, 0, 1);

    dom.timerFill.style.width = `${(fraction * 100).toFixed(1)}%`;

    if (fraction > 0.4) {
      dom.timerFill.className = 'timer-bar-fill';
    } else if (fraction > 0.15) {
      dom.timerFill.className = 'timer-bar-fill timer-amber';
    } else {
      dom.timerFill.className = 'timer-bar-fill timer-red';
    }
  }

  /* =========================================================
   * EVENT LOGGING HELPER
   * Types: 'send', 'retx', 'ack', 'dupack', 'lost', 'discard', 'timeout', 'info'
   * ========================================================= */
  function _log(message, type = 'info') {
    get().EventBus.emit('gbn:log', { message, type });

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
    const s = state.stats;
    const total = s.sent;
    const unique = state.stats.delivered;
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

    get().EventBus.emit('gbn:stat', vals);
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
    el.dataset.protocol = 'gbn';
    el.title = `DATA[${seq}] – Click to drop`;

    // Click-to-drop interaction
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      dropPacket(seq, 'data');
    });

    pkt.element = el;

    // Top transmission lane (Data →)
    const vertOffset = 14 + (seq % 2) * 6;
    el.style.top = vertOffset + 'px';
    dom.channel.appendChild(el);

    // If timer is not running, start it for the oldest unACKed packet
    if (!state.timerRunning) {
      _startTimer(simTime);
    }

    state.stats.sent++;
    _log(`[SEND] Sent DATA[${seq}]`, 'send');
    _updateStats();
    _renderWindowCells();
  }

  /* =========================================================
   * RETRANSMIT DATA PACKET (Go-Back-N recovery)
   * ========================================================= */
  function _retransmitPacket(seq, simTime) {
    const { Packet } = get();

    // Remove any stale DOM node if still lingering
    if (state.packets[seq] && state.packets[seq].element) {
      state.packets[seq].element.remove();
    }

    const pkt = new Packet(seq, 'data', simTime);
    pkt.isRetransmit = true;
    pkt.retransmitCount = (state.packets[seq] ? state.packets[seq].retransmitCount + 1 : 1);
    state.packets[seq] = pkt;

    const el = document.createElement('div');
    el.className = 'packet-el pkt-data pkt-retransmit';
    el.innerHTML = `${seq}<span class="retx-badge">RETX</span>`;
    el.dataset.seq = seq;
    el.dataset.kind = 'data';
    el.dataset.protocol = 'gbn';
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

    state.stats.sent++;
    state.stats.retransmissions++;
    _log(`[RETX] Resent DATA[${seq}] (Go-Back-N recovery)`, 'retx');
    _updateStats();
    _renderWindowCells();
  }

  /* =========================================================
   * SEND CUMULATIVE ACK
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
    el.dataset.protocol = 'gbn';
    el.title = `${isDuplicate ? 'Duplicate ' : ''}Cumulative ACK[${seq}] – Click to drop`;

    // Click-to-drop interaction on ACKs (proves cumulative ACK resilience)
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
      _log(`[DUP-ACK] Sent duplicate cumulative ACK[${seq}]`, 'dupack');
    } else {
      _log(`[ACK] Sent cumulative ACK[${seq}]`, 'ack');
    }
  }

  /* =========================================================
   * TIMEOUT HANDLER (Strict Go-Back-N recovery)
   * ========================================================= */
  function _handleTimeout(simTime) {
    state.stats.timeouts++;

    const fromSeq = state.base;
    const toSeq = state.nextSeq - 1;

    _log(`[TIMEOUT] Timer expired for packet ${fromSeq} – Go-Back-N retransmitting window [${fromSeq}..${toSeq}]`, 'timeout');
    _showToast(`⚠️ TIMEOUT on packet ${fromSeq} — Go-Back-N resending [${fromSeq}..${toSeq}]`);

    // Amber pulse on sender box
    if (dom.senderBox) {
      dom.senderBox.classList.add('sender-pulse-timeout');
      setTimeout(() => {
        if (dom.senderBox) dom.senderBox.classList.remove('sender-pulse-timeout');
      }, 800);
    }

    // Build retransmission queue for the entire window [base .. nextSeq-1]
    state.retransmitQueue = [];
    for (let s = fromSeq; s <= toSeq; s++) {
      state.retransmitQueue.push(s);
      if (state.packets[s]) {
        state.packets[s].state = 'retransmit';
      }
    }

    // Restart timer for the oldest unACKed packet
    _restartTimer(simTime);
    _renderWindowCells();
    _updateStats();
  }

  /* =========================================================
   * CLICK-TO-DROP INTERACTION
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

    _log(`[LOST] Cumulative ACK[${ack.seq}] dropped in transit! (Testing cumulative resilience)`, 'lost');

    const el = ack.element;
    ack.element = null;
    if (el) {
      get().dropPacketVisual(el, 'LOST');
    }
  }

  /* =========================================================
   * TICK LOOP (Driven by SimClock requestAnimationFrame)
   * ========================================================= */
  function _tick(simTime, deltaS) {
    if (!state || state.done) return;

    const cfg = get().SimConfig;

    /* ---- 1. Update Sender Timer Gauge ---- */
    _updateTimerGauge(simTime);

    /* ---- 2. Check Timer Expiry on Base Packet ---- */
    if (state.timerRunning && state.timerDeadline !== null && simTime >= state.timerDeadline) {
      _handleTimeout(simTime);
    }

    /* ---- 3. Inject Packets Across Channel (Spacing: txDelay) ---- */
    const canInject = (simTime >= state.lastSendTime + cfg.txDelay);

    if (canInject) {
      // Priority A: Retransmissions pending from timeout
      if (state.retransmitQueue.length > 0) {
        let rSeq = state.retransmitQueue.shift();
        // Skip if this packet was cumulatively ACKed in the meantime
        while (rSeq < state.base && state.retransmitQueue.length > 0) {
          rSeq = state.retransmitQueue.shift();
        }
        if (rSeq >= state.base) {
          _retransmitPacket(rSeq, simTime);
          state.lastSendTime = simTime;
        }
      }
      // Priority B: New transmissions within window (nextSeq < base + windowSize)
      else if (
        state.nextSeq < cfg.totalPackets &&
        state.nextSeq < state.base + state.windowSize
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

        // IN-ORDER ARRIVAL: expected sequence
        if (pkt.seq === state.expectedSeq) {
          state.expectedSeq++;
          state.stats.delivered++;
          _addToDeliveredStrip(pkt.seq);
          _log(`[ACK] Received DATA[${pkt.seq}] in-order ✓ – sending cumulative ACK[${pkt.seq}]`, 'ack');

          // Send cumulative ACK for this sequence
          _sendAck(pkt.seq, simTime, false);

          if (el) {
            el.classList.add('pkt-arrived');
            setTimeout(() => el && el.remove(), 400);
          }
        }
        // OUT-OF-ORDER ARRIVAL: discard and send duplicate ACK
        else {
          _log(`[DISCARD] Received DATA[${pkt.seq}] out-of-order (expected ${state.expectedSeq}) – discarded!`, 'discard');
          _showDiscardAlert(pkt.seq, state.expectedSeq);

          if (el) {
            el.classList.add('pkt-discarded');
            setTimeout(() => el && el.remove(), 550);
          }

          // Resend cumulative ACK for the last in-order received packet
          if (state.expectedSeq > 0) {
            const lastInOrder = state.expectedSeq - 1;
            _sendAck(lastInOrder, simTime, true);
          }
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

        // Cumulative ACK: acknowledges all packets <= ackedSeq
        if (ackedSeq >= state.base) {
          state.stats.acksReceived++;
          _log(`[ACK] Received ACK[${ackedSeq}] – cumulative ACK, window slides to ${ackedSeq + 1}`, 'ack');

          // Mark all packets up to ackedSeq as ACKed
          for (let s = state.base; s <= ackedSeq; s++) {
            if (state.packets[s]) {
              state.packets[s].state = 'acked';
            }
          }

          state.base = ackedSeq + 1;

          // Prune retransmission queue of already-ACKed packets
          state.retransmitQueue = state.retransmitQueue.filter(s => s >= state.base);

          // Timer Management:
          // If base == nextSeq: all sent packets have been ACKed -> stop timer
          if (state.base === state.nextSeq) {
            _stopTimer();
          } else {
            // Still unACKed packets in flight -> restart timer for new base
            _restartTimer(simTime);
          }

          _renderWindowCells();
          _updateStats();

          // Check if entire transfer has finished
          if (state.base >= cfg.totalPackets) {
            _finish(simTime);
          }
        } else {
          // Stale / Duplicate ACK: already accounted for, ignore
          _log(`[DUP-ACK] Received duplicate ACK[${ackedSeq}] (base is ${state.base}) – ignored`, 'dupack');
        }

        if (ackEl) {
          ackEl.classList.add('pkt-arrived');
          setTimeout(() => ackEl && ackEl.remove(), 300);
        }
      }
    });

    /* ---- 6. Update Receiver Expected Sequence Display ---- */
    if (dom.expectedSeqEl) {
      dom.expectedSeqEl.textContent = state.expectedSeq;
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
   * FINISH
   * ========================================================= */
  function _finish(simTime) {
    if (state.done) return;
    state.done = true;
    _stopTimer();
    _updateTimerGauge(simTime);
    _log(`✅ Transfer complete! Total transmissions: ${state.stats.sent}`, 'success');
    _updateStats();
    get().EventBus.emit('gbn:done', { stats: state.stats });

    const overlay = state.container.querySelector('.done-overlay');
    if (overlay) overlay.classList.remove('hidden');
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
    // Clock pausing freezes delta-time, so timer naturally preserves remaining time
  }

  function reset() {
    clearTimeout(toastTimeoutId);
    clearTimeout(discardAlertTimeoutId);

    if (state && state.container) {
      const channel = state.container.querySelector('.channel');
      if (channel) channel.innerHTML = '';
      const strip = state.container.querySelector('.delivered-strip');
      if (strip) strip.innerHTML = '';
      const log = state.container.querySelector('.arena-log');
      if (log) log.innerHTML = '';
      const overlay = state.container.querySelector('.done-overlay');
      if (overlay) overlay.classList.add('hidden');
      if (dom.toast) dom.toast.classList.add('hidden');
      if (dom.discardAlert) dom.discardAlert.classList.add('hidden');
      if (dom.senderBox) dom.senderBox.classList.remove('sender-pulse-timeout');
    }

    if (_unsubscribeClock) {
      _unsubscribeClock();
      _unsubscribeClock = null;
    }

    const container = state ? state.container : null;
    state = createInitialState();
    if (container) {
      state.container = container;
      _buildDOM(container);
      _renderWindowCells();
      _updateStats();
      _updateTimerGauge(0);
    }
  }

  function setWindowSize(n) {
    if (state) {
      state.windowSize = n;
      _renderWindowCells();
    }
  }

  function setSpeed(x) {
    get().SimConfig.speed = x;
  }

  /* Expose onto window.GBN */
  global.GBN = { init, start, pause, reset, setWindowSize, setSpeed, dropPacket };

})(window);
