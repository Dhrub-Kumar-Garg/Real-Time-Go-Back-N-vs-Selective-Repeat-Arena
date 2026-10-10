/**
 * engine.js  –  Shared simulation engine
 * ----------------------------------------
 * Provides:
 *   • EventBus  – lightweight pub/sub for cross-module communication
 *   • SimConfig  – global simulation parameters (shared, reactive)
 *   • SimClock   – requestAnimationFrame-based clock with pause/speed support
 *   • Packet     – canonical packet data model (used by both GBN and SR)
 *   • helpers    – lerp, easing, color constants
 *
 * Both gbn.js and sr.js import from this module via the global `Engine`
 * object attached to window.
 */

(function (global) {
  'use strict';

  /* =========================================================
   * 1. EVENT BUS
   * A simple publish/subscribe system so protocols can emit
   * stats/log events without direct coupling to the UI.
   * ========================================================= */
  const EventBus = {
    _listeners: {},

    /**
     * Subscribe to an event.
     * @param {string} event
     * @param {Function} callback
     */
    on(event, callback) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(callback);
      return () => this.off(event, callback);
    },

    /**
     * Unsubscribe a specific callback.
     * @param {string} event
     * @param {Function} callback
     */
    off(event, callback) {
      if (!this._listeners[event]) return;
      this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
    },

    /**
     * Emit an event, calling all registered listeners.
     * @param {string} event
     * @param {*} data
     */
    emit(event, data) {
      if (!this._listeners[event]) return;
      this._listeners[event].forEach(cb => {
        try { cb(data); } catch (e) { console.error(`EventBus error in "${event}":`, e); }
      });
    },
  };

  /* =========================================================
   * 2. SIMULATION CONFIG (reactive)
   * Central store for all slider-driven parameters.
   * Protocols read these on every frame; changing them takes
   * effect immediately without a restart.
   * ========================================================= */
  const SimConfig = {
    windowSize: 4,       // W  – max unACKed packets in flight
    speed: 1.0,          // multiplier applied to SimClock
    timeoutDuration: 3.0,// seconds (simulation time) before retransmit
    totalPackets: 12,    // total distinct data packets to deliver
    mirrorDrops: true,   // when true, dropping DATA packet in one arena mirrors to the other

    // Transit times in simulation-seconds (before speed scaling)
    propagationDelay: 1.6,  // sender → receiver one-way
    ackDelay: 1.2,          // receiver → sender one-way
    txDelay: 0.35,          // inter-packet injection spacing across the link
  };

  /* =========================================================
   * 3. PACKET DATA MODEL
   * Every packet in flight (data or ACK) is an instance of this.
   * Having a unified structure means Phase 2 (drop/retransmit)
   * can add new states without changing callers.
   * ========================================================= */
  /**
   * Packet states:
   *   'queued'      – not yet sent
   *   'in-flight'   – traveling sender → receiver
   *   'delivered'   – received by receiver
   *   'acked'       – ACK received by sender (window can slide)
   *   'dropped'     – lost in transit (Phase 2)
   *   'timeout'     – sender timer expired, will retransmit (Phase 2)
   *   'retransmit'  – currently being re-sent (Phase 2)
   *   'buffered'    – SR only: out-of-order, held in receiver buffer
   *
   * ACK packet states:
   *   'ack-flight'  – ACK traveling receiver → sender
   *   'ack-arrived' – ACK reached sender
   *   'ack-dropped' – ACK lost (Phase 2)
   */
  class Packet {
    /**
     * @param {number} seq        – sequence number
     * @param {'data'|'ack'} kind – whether this is a data packet or ACK
     * @param {number} sendTime   – simulation time when packet was sent
     */
    constructor(seq, kind, sendTime) {
      this.seq = seq;
      this.kind = kind;          // 'data' | 'ack'
      this.sendTime = sendTime;  // simulation seconds at launch
      this.arrivalTime = null;   // set when packet reaches its destination
      this.state = (kind === 'data') ? 'in-flight' : 'ack-flight';
      this.element = null;       // DOM element, set by the renderer
      this.dropped = false;      // Phase 2: marked true when click-dropped
      this.isRetransmit = false; // Phase 2: true if retransmitted
      this.retransmitCount = 0;  // Phase 2: how many times re-sent
      // Per-packet timer handle
      this.timerDeadline = null;
    }
  }

  /* =========================================================
   * 4. SIMULATION CLOCK
   * Drives both protocols from a single rAF loop.
   * `simTime` advances by (deltaMs / 1000) * speed each frame.
   * Pause simply stops advancing simTime.
   * ========================================================= */
  const SimClock = {
    simTime: 0,        // total elapsed simulation seconds
    _running: false,
    _lastTimestamp: null,
    _subscribers: [],  // functions called every tick: fn(simTime, deltaS)

    /** Register a per-frame callback. Returns an unsubscribe fn. */
    subscribe(fn) {
      this._subscribers.push(fn);
      return () => { this._subscribers = this._subscribers.filter(f => f !== fn); };
    },

    /** Start (or resume) the clock. */
    start() {
      if (this._running) return;
      this._running = true;
      this._lastTimestamp = null;
      requestAnimationFrame(ts => this._tick(ts));
    },

    /** Pause the clock (simTime stops advancing). */
    pause() {
      this._running = false;
    },

    /** Hard reset: zero simTime and stop. */
    reset() {
      this._running = false;
      this.simTime = 0;
      this._lastTimestamp = null;
    },

    _tick(timestamp) {
      if (!this._running) return;

      if (this._lastTimestamp !== null) {
        const deltaMs = timestamp - this._lastTimestamp;
        const deltaS = (deltaMs / 1000) * SimConfig.speed;
        this.simTime += deltaS;

        // Notify all subscribers
        this._subscribers.forEach(fn => {
          try { fn(this.simTime, deltaS); } catch (e) { console.error('SimClock tick error:', e); }
        });
      }

      this._lastTimestamp = timestamp;
      requestAnimationFrame(ts => this._tick(ts));
    },
  };

  /* =========================================================
   * 5. UTILITY HELPERS
   * ========================================================= */

  /**
   * Linear interpolation between a and b by t ∈ [0,1].
   */
  function lerp(a, b, t) {
    return a + (b - a) * Math.max(0, Math.min(1, t));
  }

  /**
   * Ease-in-out cubic for smoother packet motion.
   */
  function easeInOut(t) {
    t = Math.max(0, Math.min(1, t));
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  /**
   * Format a number to 1 decimal place.
   */
  function fmt1(n) {
    return Math.round(n * 10) / 10;
  }

  /**
   * Clamp a value between min and max.
   */
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  /* =========================================================
   * 6. COLOR / VISUAL CONSTANTS
   * Centralised so styles.css variables and JS always match.
   * ========================================================= */
  const Colors = {
    packet: '#4f9cf9',      // data packet – blue
    ack: '#34d399',         // ACK – green
    dropped: '#f87171',     // dropped/lost – red
    timeout: '#fbbf24',     // timeout/retransmit – amber
    buffered: '#a78bfa',    // buffered (SR) – purple
    acked: '#1e3a5f',       // already ACKed cell – dark blue
    window: '#4f9cf9',      // window highlight border
  };

  /**
   * Shared visual mechanic for click-to-drop (Phase 2 & Phase 3):
   * Displays an immediate "✕ LOST" burst, halts interaction, and fades out.
   */
  function dropPacketVisual(element, labelText = 'LOST', durationMs = 650) {
    if (!element) return;
    element.classList.add('pkt-dropped');
    element.innerHTML = `<span class="pkt-lost-x">✕</span><span class="pkt-lost-tag">${labelText}</span>`;
    element.style.pointerEvents = 'none';
    setTimeout(() => {
      if (element && element.parentNode) {
        element.remove();
      }
    }, durationMs);
  }

  /* =========================================================
   * 7. SOUND EFFECTS (Web Audio API – Pure Synthesis, No Files)
   * ========================================================= */
  const Sound = {
    enabled: false,
    _ctx: null,

    _getCtx() {
      if (!this._ctx && (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext)) {
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          this._ctx = new AudioCtx();
        } catch (e) {}
      }
      if (this._ctx && this._ctx.state === 'suspended') {
        this._ctx.resume().catch(() => {});
      }
      return this._ctx;
    },

    toggle() {
      this.enabled = !this.enabled;
      if (this.enabled) {
        this._getCtx();
        this.play('ack');
      }
      EventBus.emit('sound:toggled', { enabled: this.enabled });
      return this.enabled;
    },

    play(type) {
      if (!this.enabled) return;
      const ctx = this._getCtx();
      if (!ctx) return;

      try {
        const now = ctx.currentTime;
        if (type === 'send') {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(540, now);
          osc.frequency.exponentialRampToValueAtTime(720, now + 0.04);
          gain.gain.setValueAtTime(0.04, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.045);
        } else if (type === 'ack') {
          const osc1 = ctx.createOscillator();
          const osc2 = ctx.createOscillator();
          const gain = ctx.createGain();
          osc1.type = 'sine';
          osc2.type = 'triangle';
          osc1.frequency.setValueAtTime(659.25, now);
          osc2.frequency.setValueAtTime(880.00, now);
          gain.gain.setValueAtTime(0.04, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
          osc1.connect(gain);
          osc2.connect(gain);
          gain.connect(ctx.destination);
          osc1.start(now);
          osc2.start(now);
          osc1.stop(now + 0.1);
          osc2.stop(now + 0.1);
        } else if (type === 'loss') {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(220, now);
          osc.frequency.exponentialRampToValueAtTime(70, now + 0.09);
          gain.gain.setValueAtTime(0.07, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.095);
        } else if (type === 'timeout') {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(440, now);
          osc.frequency.setValueAtTime(330, now + 0.06);
          gain.gain.setValueAtTime(0.03, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.145);
        }
      } catch (err) {}
    }
  };

  /* =========================================================
   * 8. PROTOCOL INTERFACE CONTRACT
   * Each protocol file (gbn.js, sr.js) must export an object
   * conforming to this interface onto window.GBN / window.SR.
   * ========================================================= */

  /* =========================================================
   * 9. EXPORT onto window.Engine
   * ========================================================= */
  global.Engine = {
    EventBus,
    SimConfig,
    SimClock,
    Packet,
    Sound,
    lerp,
    easeInOut,
    fmt1,
    clamp,
    Colors,
    dropPacketVisual,
  };

})(window);
