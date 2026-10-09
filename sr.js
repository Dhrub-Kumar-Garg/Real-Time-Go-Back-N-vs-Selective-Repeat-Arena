/**
 * sr.js  –  Selective Repeat protocol simulator
 * -----------------------------------------------
 * Implements the SR sliding-window protocol with a time-based
 * animation engine. Exposes the standard Protocol interface.
 *
 * SR Rules:
 *  • Sender: can have up to windowSize unACKed packets in flight.
 *  • Receiver: accepts ANY packet within its receive window.
 *    Out-of-order packets are BUFFERED until the missing gap fills.
 *  • ACKs are INDIVIDUAL: ACK(n) acknowledges only packet n.
 *  • On timeout (Phase 2): retransmit ONLY the timed-out packet.
 *  • Receiver delivers the longest in-order prefix when a gap fills.
 *
 * Architecture notes for Phase 2:
 *  - `_recvBuffer` is a Map: seq → true (received but not yet delivered).
 *  - `_deliveredUpTo` tracks the in-order delivery frontier.
 *  - Individual per-packet timers in `state._timers` (ready for Phase 2).
 *  - `dropPacket(seq)` stub wired, Phase 2 fills it in.
 */

(function (global) {
  'use strict';

  const get = () => global.Engine;

  /* =========================================================
   * STATE
   * ========================================================= */
  let state = null;

  function createInitialState() {
    const cfg = get().SimConfig;
    return {
      // Sender window
      base: 0,
      nextSeq: 0,
      windowSize: cfg.windowSize,

      // All data packets launched (key = seq)
      packets: {},

      // ACK packets in flight
      acks: [],

      // Receiver state
      // SR receiver window starts at 0 and expands as packets deliver
      recvBase: 0,         // oldest seq receiver is still waiting for
      _recvBuffer: new Map(),  // buffered received-but-not-delivered packets
      _deliveredUpTo: -1,      // highest consecutive seq delivered to upper layer

      // Visual buffer slots (rendered as a row)
      _bufferSlots: [],    // array of booleans length = windowSize

      // Stats
      stats: {
        sent: 0,
        retransmissions: 0,
        acksReceived: 0,
        timeouts: 0,
        lost: 0,
        delivered: 0,
      },

      // Per-packet timer deadlines (Phase 2 ready)
      _timers: new Map(),

      done: false,
      container: null,
    };
  }

  /* =========================================================
   * DOM REFERENCES
   * ========================================================= */
  let dom = {
    senderWindow: null,
    channel: null,
    bufferArray: null,   // SR-specific: visual receiver buffer
    deliveredStrip: null,
    statsEls: {},
    logEl: null,
  };

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
    dom.senderWindow   = container.querySelector('.sender-window');
    dom.channel        = container.querySelector('.channel');
    dom.bufferArray    = container.querySelector('.buffer-array');
    dom.deliveredStrip = container.querySelector('.delivered-strip');
    dom.logEl          = container.querySelector('.arena-log');

    ['sent','retransmissions','acks','timeouts','lost','efficiency'].forEach(key => {
      dom.statsEls[key] = container.querySelector(`.stat-${key}`);
    });
  }

  /* =========================================================
   * WINDOW CELL RENDERER
   * Same as GBN but SR receiver can buffer out-of-order, so we
   * also show received-but-waiting cells differently.
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
      if (!pkt) {
        cell.classList.add('wc-queued');
      } else if (pkt.state === 'acked') {
        cell.classList.add('wc-acked');
      } else if (pkt.state === 'in-flight' || pkt.state === 'delivered') {
        cell.classList.add('wc-inflight');
      }

      const inWindow = i >= state.base && i < state.base + state.windowSize;
      if (inWindow && i < total) {
        cell.classList.add('wc-window');
      }

      dom.senderWindow.appendChild(cell);
    }
  }

  /* =========================================================
   * SR RECEIVER BUFFER RENDERER
   * Shows a row of windowSize slots; filled = purple chip, empty = outline.
   * ========================================================= */
  function _renderBuffer() {
    if (!dom.bufferArray) return;
    dom.bufferArray.innerHTML = '';

    const cfg = get().SimConfig;
    const wSize = state.windowSize || cfg.windowSize;

    for (let i = 0; i < wSize; i++) {
      const slot = document.createElement('div');
      slot.className = 'buffer-slot';
      const seq = state.recvBase + i;

      if (state._recvBuffer.has(seq)) {
        slot.classList.add('buf-filled');
        slot.textContent = seq;
        slot.title = `Buffered: seq ${seq}`;
      } else if (seq > state._deliveredUpTo + 1 && seq < state.recvBase + wSize) {
        slot.classList.add('buf-waiting');
        slot.textContent = seq;
        slot.title = `Waiting: seq ${seq}`;
      } else {
        slot.textContent = seq < get().SimConfig.totalPackets ? seq : '–';
        slot.title = `Slot ${i}`;
      }

      dom.bufferArray.appendChild(slot);
    }
  }

  /* =========================================================
   * LOG HELPER
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
   * STATS HELPER
   * ========================================================= */
  function _updateStats() {
    const s = state.stats;
    const total = s.sent;
    const unique = get().SimConfig.totalPackets;
    const eff = total > 0 ? ((unique / total) * 100).toFixed(1) + '%' : '–';

    const vals = {
      sent: s.sent,
      retransmissions: s.retransmissions,
      acks: s.acksReceived,
      timeouts: s.timeouts,
      lost: s.lost || 0,
      efficiency: eff,
    };

    Object.entries(vals).forEach(([key, val]) => {
      if (dom.statsEls[key]) dom.statsEls[key].textContent = val;
    });

    get().EventBus.emit('sr:stat', vals);
  }

  /* =========================================================
   * PACKET DOM ELEMENT FACTORY
   * ========================================================= */
  function _createPacketEl(pkt) {
    const el = document.createElement('div');
    el.className = `packet-el pkt-${pkt.kind} pkt-disabled`;
    el.textContent = pkt.seq;
    el.dataset.seq = pkt.seq;
    el.dataset.kind = pkt.kind;
    el.dataset.protocol = 'sr';
    el.title = 'SR loss handling coming next';

    // In Phase 2: SR remains strictly happy-path
    pkt.element = el;
    return el;
  }

  /* =========================================================
   * PACKET POSITION CALCULATOR
   * ========================================================= */
  function _packetProgress(pkt, simTime) {
    const cfg = get().SimConfig;
    const delay = pkt.kind === 'data' ? cfg.propagationDelay : cfg.ackDelay;
    const elapsed = simTime - pkt.sendTime;
    return get().clamp(elapsed / delay, 0, 1);
  }

  /* =========================================================
   * SEND DATA PACKET
   * ========================================================= */
  function _sendPacket(seq, simTime) {
    const { Packet } = get();
    const pkt = new Packet(seq, 'data', simTime);
    state.packets[seq] = pkt;

    const el = _createPacketEl(pkt);
    // Vertical position: DATA lane is top half (divider at 50%)
    const vertOffset = 14 + (seq % 2) * 6;
    el.style.top = vertOffset + 'px';
    dom.channel.appendChild(el);

    state.stats.sent++;
    _log(`Sent DATA[${seq}]`, 'info');
    _updateStats();
    _renderWindowCells(); // update window cells to show in-flight

    // Phase 2 ready: set per-packet timer deadline
    state._timers.set(seq, simTime + get().SimConfig.timeoutDuration);
  }

  /* =========================================================
   * SEND INDIVIDUAL ACK
   * ========================================================= */
  function _sendAck(seq, simTime) {
    const { Packet } = get();
    const ack = new Packet(seq, 'ack', simTime);
    state.acks.push(ack);

    const el = _createPacketEl(ack);
    // Vertical position: ACK lane is bottom half
    const vertOffset = 64 + (seq % 2) * 6;
    el.style.top = vertOffset + 'px';
    dom.channel.appendChild(el);

    _log(`Sent ACK[${seq}]`, 'success');
  }

  /* =========================================================
   * DELIVER IN-ORDER PREFIX
   * Called after any new packet is buffered. Delivers the longest
   * consecutive sequence starting from recvBase.
   * ========================================================= */
  function _deliverInOrderPrefix(simTime) {
    const cfg = get().SimConfig;

    while (state._recvBuffer.has(state.recvBase)) {
      const seq = state.recvBase;
      state._recvBuffer.delete(seq);
      state._deliveredUpTo = seq;
      state.stats.delivered++;
      state.recvBase++;
      _log(`Delivered DATA[${seq}] to upper layer ✓`, 'success');
      _addToDeliveredStrip(seq);
    }
    _renderBuffer();
  }

  /* =========================================================
   * TICK
   * ========================================================= */
  function _tick(simTime, deltaS) {
    if (!state || state.done) return;

    const cfg = get().SimConfig;

    /* ---- 1. Try to send new packets (within sender window) ---- */
    while (
      state.nextSeq < cfg.totalPackets &&
      state.nextSeq < state.base + state.windowSize
    ) {
      _sendPacket(state.nextSeq, simTime);
      state.nextSeq++;
    }

    /* ---- 2. Animate DATA packets in flight ---- */
    const channelWidth = dom.channel ? dom.channel.clientWidth : 800;
    const packetW = 36;

    Object.values(state.packets).forEach(pkt => {
      if (pkt.state !== 'in-flight') return;
      if (!pkt.element) return;

      const t = _packetProgress(pkt, simTime);
      const xPx = get().lerp(0, channelWidth - packetW, get().easeInOut(t));
      pkt.element.style.left = xPx + 'px';

      /* ---- Receiver: packet arrives ---- */
      if (t >= 1 && pkt.state === 'in-flight') {
        pkt.state = 'delivered';
        pkt.arrivalTime = simTime;

        const el = pkt.element;
        pkt.element = null;

        const seq = pkt.seq;
        const recvWinEnd = state.recvBase + state.windowSize;

        // SR receiver: accept if within receive window
        if (seq >= state.recvBase && seq < recvWinEnd && !state._recvBuffer.has(seq)) {
          state._recvBuffer.set(seq, true);
          _log(`Received DATA[${seq}] – buffered`, 'info');

          // Deliver contiguous prefix
          _deliverInOrderPrefix(simTime);

          // Send individual ACK
          _sendAck(seq, simTime);
        } else if (seq < state.recvBase) {
          // Already delivered; send ACK again (duplicate, but correct)
          _log(`Received DATA[${seq}] – already delivered, re-ACK`, 'warn');
          _sendAck(seq, simTime);
        } else {
          _log(`Received DATA[${seq}] – outside window, discarded`, 'warn');
        }

        if (el) {
          el.classList.add('pkt-arrived');
          setTimeout(() => el.remove(), 400);
        }
      }
    });

    /* ---- 3. Animate ACK packets in flight ---- */
    state.acks.forEach(ack => {
      if (ack.state !== 'ack-flight') return;
      if (!ack.element) return;

      const t = _packetProgress(ack, simTime);
      const xPx = get().lerp(channelWidth - packetW, 0, get().easeInOut(t));
      ack.element.style.left = xPx + 'px';

      /* ---- Sender: ACK arrives ---- */
      if (t >= 1 && ack.state === 'ack-flight') {
        ack.state = 'ack-arrived';
        ack.arrivalTime = simTime;

        const ackEl = ack.element;
        ack.element = null;

        const ackedSeq = ack.seq;
        state.stats.acksReceived++;
        _log(`Received ACK[${ackedSeq}]`, 'success');

        // SR: individual ACK – mark that packet as acked
        if (state.packets[ackedSeq]) {
          state.packets[ackedSeq].state = 'acked';
          state._timers.delete(ackedSeq);
        }

        // Slide sender base forward over consecutive acked packets
        while (state.packets[state.base] && state.packets[state.base].state === 'acked') {
          state.base++;
        }

        _renderWindowCells();
        _updateStats();

        if (ackEl) {
          ackEl.classList.add('pkt-arrived');
          setTimeout(() => ackEl.remove(), 300);
        }

        // Check done
        if (state.base >= cfg.totalPackets) {
          _finish(simTime);
        }
      }
    });
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
    _log(`✅ Transfer complete!  Total sent: ${state.stats.sent}`, 'success');
    _updateStats();
    get().EventBus.emit('sr:done', { stats: state.stats });

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

  function pause() {}

  function reset() {
    if (state && state.container) {
      const channel = state.container.querySelector('.channel');
      if (channel) channel.innerHTML = '';
      const strip = state.container.querySelector('.delivered-strip');
      if (strip) strip.innerHTML = '';
      const log = state.container.querySelector('.arena-log');
      if (log) log.innerHTML = '';
      const overlay = state.container.querySelector('.done-overlay');
      if (overlay) overlay.classList.add('hidden');
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
   * dropPacket(seq)  –  In Phase 2, SR arena stays happy path.
   * Packet loss for SR will be implemented in Phase 3.
   */
  function dropPacket(seq) {
    // No-op for SR in Phase 2
  }

  global.SR = { init, start, pause, reset, setWindowSize, setSpeed, dropPacket };

})(window);
