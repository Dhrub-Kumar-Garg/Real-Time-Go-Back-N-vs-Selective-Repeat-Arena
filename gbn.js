/**
 * gbn.js  –  Go-Back-N protocol simulator
 * ----------------------------------------
 * Implements the GBN sliding-window protocol with a time-based
 * animation engine. Exposes the standard Protocol interface defined
 * in engine.js.
 *
 * GBN Rules:
 *  • Sender: can have up to windowSize unACKed packets in flight.
 *  • Receiver: only accepts the NEXT expected packet in order.
 *    Out-of-order packets are silently discarded (no buffering).
 *  • ACKs are CUMULATIVE: ACK(n) means all packets up to n received.
 *  • On timeout (Phase 2): retransmit entire window from base.
 *
 * Architecture notes for Phase 2:
 *  - Every packet is a `Packet` object; state transitions are explicit.
 *  - `_timers` map: seq → deadline (simulation seconds). Currently set
 *    but never acted upon; Phase 2 will check them each tick.
 *  - `dropPacket(seq)` stub is wired; Phase 2 fills it in.
 */

(function (global) {
  'use strict';

  /* Shorthand aliases for Engine exports */
  const get = () => global.Engine;

  /* =========================================================
   * STATE
   * All mutable protocol state lives here so reset() can
   * wipe it cleanly.
   * ========================================================= */
  let state = null;

  function createInitialState() {
    const cfg = get().SimConfig;
    return {
      // Sender window
      base: 0,                 // oldest unACKed seq number
      nextSeq: 0,              // next seq to send
      windowSize: cfg.windowSize,

      // Packets: all known data packets across their lifecycle
      // key = seq number (string), value = Packet
      packets: {},

      // ACK packets in flight (array of Packet objects)
      acks: [],

      // Receiver state
      expectedSeq: 0,          // GBN receiver only accepts this seq

      // Stats
      stats: {
        sent: 0,
        retransmissions: 0,
        acksReceived: 0,
        timeouts: 0,
        delivered: 0,
      },

      // Per-packet timer deadlines (Phase 2 ready)
      // Map: seq → simTime deadline
      _timers: new Map(),

      // Whether simulation has finished
      done: false,

      // Container DOM element (set by init())
      container: null,

      // Canvas-like channel region dimensions (set after DOM ready)
      channelRect: null,
    };
  }

  /* =========================================================
   * DOM REFERENCES (set in init())
   * ========================================================= */
  let dom = {
    senderWindow: null,  // the sliding-window cells row
    channel: null,       // the flight path div
    expectedSeqEl: null, // "Expected seq: X" label
    deliveredStrip: null,// ordered delivery strip
    statsEls: {},        // stat value spans keyed by stat name
    logEl: null,         // scrolling log div
  };

  /* =========================================================
   * INIT  –  build DOM skeleton inside the given container
   * ========================================================= */
  function init(container) {
    state = createInitialState();
    state.container = container;
    _buildDOM(container);
    _renderWindowCells();
    _updateStats();
  }

  function _buildDOM(container) {
    /* The arena HTML is already in index.html; we just grab refs */
    dom.senderWindow  = container.querySelector('.sender-window');
    dom.channel       = container.querySelector('.channel');
    dom.expectedSeqEl = container.querySelector('.expected-seq-value');
    dom.deliveredStrip= container.querySelector('.delivered-strip');
    dom.logEl         = container.querySelector('.arena-log');

    /* Stats spans */
    ['sent','retransmissions','acks','timeouts','efficiency'].forEach(key => {
      dom.statsEls[key] = container.querySelector(`.stat-${key}`);
    });
  }

  /* =========================================================
   * WINDOW CELL RENDERER
   * Draws a row of seq-number cells 0..totalPackets-1 and
   * highlights the current window bracket.
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

      // State coloring
      const pkt = state.packets[i];
      if (!pkt) {
        // Not sent yet
        cell.classList.add('wc-queued');
      } else if (pkt.state === 'acked') {
        cell.classList.add('wc-acked');
      } else if (pkt.state === 'in-flight' || pkt.state === 'delivered') {
        cell.classList.add('wc-inflight');
      }

      // Window bracket highlight
      const inWindow = i >= state.base && i < state.base + state.windowSize;
      if (inWindow && i < total) {
        cell.classList.add('wc-window');
      }

      dom.senderWindow.appendChild(cell);
    }
  }

  /* =========================================================
   * LOG HELPER
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
      efficiency: eff,
    };

    Object.entries(vals).forEach(([key, val]) => {
      if (dom.statsEls[key]) dom.statsEls[key].textContent = val;
    });

    get().EventBus.emit('gbn:stat', vals);
  }

  /* =========================================================
   * PACKET DOM ELEMENT FACTORY
   * ========================================================= */
  function _createPacketEl(pkt) {
    const el = document.createElement('div');
    el.className = `packet-el pkt-${pkt.kind}`;
    el.textContent = pkt.seq;
    el.dataset.seq = pkt.seq;
    el.dataset.kind = pkt.kind;
    el.dataset.protocol = 'gbn';

    // Attach click handler stub for Phase 2 drop
    el.addEventListener('click', () => {
      if (pkt.kind === 'data' && pkt.state === 'in-flight') {
        dropPacket(pkt.seq);
      }
    });

    pkt.element = el;
    return el;
  }

  /* =========================================================
   * PACKET POSITION CALCULATOR
   * Returns a CSS left% value [0..100] based on:
   *   - how much simulation time has elapsed since sendTime
   *   - the propagation delay in SimConfig
   * Direction: data goes left→right (0%→100%), ACK right→left (100%→0%)
   * ========================================================= */
  function _packetProgress(pkt, simTime) {
    const cfg = get().SimConfig;
    const delay = pkt.kind === 'data' ? cfg.propagationDelay : cfg.ackDelay;
    const elapsed = simTime - pkt.sendTime;
    return get().clamp(elapsed / delay, 0, 1);
  }

  /* =========================================================
   * SEND DATA PACKET
   * Creates a Packet object, appends its DOM element to the
   * channel, and records it in state.packets.
   * ========================================================= */
  function _sendPacket(seq, simTime) {
    const { Packet } = get();
    const pkt = new Packet(seq, 'data', simTime);
    state.packets[seq] = pkt;

    const el = _createPacketEl(pkt);
    // Vertical position: DATA lane is top half (divider at 50%)
    const vertOffset = 14 + (seq % 2) * 6; // px from top of channel
    el.style.top = vertOffset + 'px';
    dom.channel.appendChild(el);

    state.stats.sent++;
    _log(`Sent DATA[${seq}]`, 'info');
    _updateStats();
    _renderWindowCells(); // update window cells to show in-flight

    // Phase 2 ready: set timer deadline
    state._timers.set(seq, simTime + get().SimConfig.timeoutDuration);
  }

  /* =========================================================
   * SEND ACK (called by receiver logic)
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
   * TICK  –  called every animation frame by SimClock
   * ========================================================= */
  function _tick(simTime, deltaS) {
    if (!state || state.done) return;

    const cfg = get().SimConfig;

    /* ---- 1. Try to send new packets (within window) ---- */
    while (
      state.nextSeq < cfg.totalPackets &&
      state.nextSeq < state.base + state.windowSize
    ) {
      _sendPacket(state.nextSeq, simTime);
      state.nextSeq++;
    }

    /* ---- 2. Animate DATA packets in flight ---- */
    const channelWidth = dom.channel ? dom.channel.clientWidth : 800;
    const packetW = 36; // px (matches CSS)

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

        // GBN: only accept in-order
        if (pkt.seq === state.expectedSeq) {
          // Accept and advance expected
          state.expectedSeq++;
          _log(`Received DATA[${pkt.seq}] ✓  –  expected, ACK`, 'success');
          _addToDeliveredStrip(pkt.seq);

          // Send cumulative ACK for this seq
          _sendAck(pkt.seq, simTime);

          if (el) {
            el.classList.add('pkt-arrived');
            setTimeout(() => el.remove(), 400);
          }
        } else {
          // Out-of-order: GBN discards silently (will be retransmitted)
          _log(`Received DATA[${pkt.seq}] ✗  –  expected ${state.expectedSeq}, discarded`, 'warn');
          if (el) {
            el.classList.add('pkt-discarded');
            setTimeout(() => el.remove(), 600);
          }
        }
      }
    });

    /* ---- 3. Animate ACK packets in flight ---- */
    state.acks.forEach(ack => {
      if (ack.state !== 'ack-flight') return;
      if (!ack.element) return;

      const t = _packetProgress(ack, simTime);
      // ACK travels right→left
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
        _log(`Received ACK[${ackedSeq}] – window slides`, 'success');

        // GBN cumulative ACK: slide base up to ackedSeq+1
        if (ackedSeq + 1 > state.base) {
          // Mark all packets up to ackedSeq as 'acked'
          for (let s = state.base; s <= ackedSeq; s++) {
            if (state.packets[s]) {
              state.packets[s].state = 'acked';
              state._timers.delete(s);  // cancel their timers
            }
          }
          state.base = ackedSeq + 1;
          _renderWindowCells();
          _updateStats();
        }

        if (ackEl) {
          ackEl.classList.add('pkt-arrived');
          setTimeout(() => ackEl.remove(), 300);
        }

        // Check if we're done
        if (state.base >= cfg.totalPackets) {
          _finish(simTime);
        }
      }
    });

    /* ---- 4. Update expected-seq display ---- */
    if (dom.expectedSeqEl) {
      dom.expectedSeqEl.textContent = state.expectedSeq;
    }
  }

  /* =========================================================
   * DELIVERED STRIP  –  shows in-order delivered packets
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
    get().EventBus.emit('gbn:done', { stats: state.stats });

    // Show visual done overlay in arena
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
    // SimClock.start() is called by main.js (shared)
  }

  function pause() {
    // SimClock.pause() is called by main.js (shared)
    // Protocol doesn't need to do anything extra
  }

  function reset() {
    // Remove all in-flight packet elements from DOM
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

    // Re-init
    const container = state ? state.container : null;
    state = createInitialState();
    if (container) {
      state.container = container;
      _buildDOM(container);
      _renderWindowCells();
      _updateStats();
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

  /**
   * dropPacket(seq)  –  Phase 2 stub.
   * Marks the packet as dropped; Phase 2 will handle the visual
   * effect and retransmission.
   * @param {number} seq
   */
  function dropPacket(seq) {
    const pkt = state && state.packets[seq];
    if (!pkt || pkt.state !== 'in-flight') return;
    pkt.dropped = true;
    pkt.state = 'dropped';
    const el = pkt.element;
    if (el) {
      el.classList.add('pkt-dropped');
      setTimeout(() => el.remove(), 700);
      pkt.element = null;
    }
    _log(`⚡ Packet [${seq}] dropped!`, 'error');

    // Mirror drops
    if (get().SimConfig.mirrorDrops && global.SR) {
      global.SR.dropPacket(seq);
    }
  }

  /* Expose on window */
  global.GBN = { init, start, pause, reset, setWindowSize, setSpeed, dropPacket };

})(window);
