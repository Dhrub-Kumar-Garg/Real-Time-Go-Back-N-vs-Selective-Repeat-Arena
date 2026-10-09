/**
 * main.js  –  Wiring layer
 * -------------------------
 * Connects the global controls (sliders, buttons) to the
 * SimClock, SimConfig, GBN, and SR protocols.
 *
 * Responsibilities:
 *  1. Initialize both protocol arenas on DOMContentLoaded.
 *  2. Wire the Play/Pause, Reset buttons.
 *  3. Wire all sliders (window size, speed, timeout, total packets).
 *  4. Wire the Mirror Drops toggle.
 *  5. Handle both protocols finishing → show comparison modal.
 *  6. Listen for EventBus events (currently for future extensibility).
 */

(function (global) {
  'use strict';

  /* Shorthand */
  const E = () => global.Engine;

  /* =========================================================
   * APPLICATION STATE
   * ========================================================= */
  let isRunning = false;
  let gbnDone = false;
  let srDone = false;

  /* =========================================================
   * DOM REFERENCES
   * ========================================================= */
  let dom = {};

  function grabDom() {
    dom = {
      playBtn:         document.getElementById('btn-play'),
      resetBtn:        document.getElementById('btn-reset'),
      windowSlider:    document.getElementById('slider-window'),
      windowVal:       document.getElementById('val-window'),
      speedSlider:     document.getElementById('slider-speed'),
      speedVal:        document.getElementById('val-speed'),
      timeoutSlider:   document.getElementById('slider-timeout'),
      timeoutVal:      document.getElementById('val-timeout'),
      totalSlider:     document.getElementById('slider-total'),
      totalVal:        document.getElementById('val-total'),
      mirrorToggle:    document.getElementById('toggle-mirror'),
      gbnArena:        document.getElementById('arena-gbn'),
      srArena:         document.getElementById('arena-sr'),
      compModal:       document.getElementById('comparison-modal'),
      compClose:       document.getElementById('modal-close'),
    };
  }

  /* =========================================================
   * INIT BOTH PROTOCOLS
   * ========================================================= */
  function initProtocols() {
    if (!dom.gbnArena || !dom.srArena) {
      console.error('Arena containers not found in DOM');
      return;
    }
    global.GBN.init(dom.gbnArena);
    global.SR.init(dom.srArena);
  }

  /* =========================================================
   * PLAY / PAUSE
   * ========================================================= */
  function togglePlay() {
    if (isRunning) {
      // Pause
      E().SimClock.pause();
      isRunning = false;
      dom.playBtn.textContent = '▶ Play';
      dom.playBtn.classList.remove('btn-pause');
      dom.playBtn.classList.add('btn-play');
    } else {
      // Play / Resume
      global.GBN.start();
      global.SR.start();
      E().SimClock.start();
      isRunning = true;
      dom.playBtn.textContent = '⏸ Pause';
      dom.playBtn.classList.remove('btn-play');
      dom.playBtn.classList.add('btn-pause');
    }
  }

  /* =========================================================
   * RESET
   * ========================================================= */
  function resetAll() {
    // Stop clock first
    E().SimClock.pause();
    E().SimClock.reset();
    isRunning = false;
    gbnDone = false;
    srDone = false;

    // Reset both protocols
    global.GBN.reset();
    global.SR.reset();

    // Reset button label
    dom.playBtn.textContent = '▶ Play';
    dom.playBtn.classList.remove('btn-pause');
    dom.playBtn.classList.add('btn-play');

    // Hide comparison modal
    if (dom.compModal) dom.compModal.classList.add('hidden');
  }

  /* =========================================================
   * SLIDER WIRING
   * ========================================================= */
  function wireSliders() {
    const cfg = E().SimConfig;

    /* Window Size */
    dom.windowSlider.addEventListener('input', () => {
      const n = parseInt(dom.windowSlider.value, 10);
      cfg.windowSize = n;
      dom.windowVal.textContent = n;
      global.GBN.setWindowSize(n);
      global.SR.setWindowSize(n);
    });
    dom.windowVal.textContent = dom.windowSlider.value;

    /* Speed */
    dom.speedSlider.addEventListener('input', () => {
      const x = parseFloat(dom.speedSlider.value);
      cfg.speed = x;
      dom.speedVal.textContent = x.toFixed(1) + 'x';
      global.GBN.setSpeed(x);
      global.SR.setSpeed(x);
    });
    dom.speedVal.textContent = parseFloat(dom.speedSlider.value).toFixed(1) + 'x';

    /* Timeout */
    dom.timeoutSlider.addEventListener('input', () => {
      const t = parseFloat(dom.timeoutSlider.value);
      cfg.timeoutDuration = t;
      dom.timeoutVal.textContent = t.toFixed(1) + 's';
    });
    dom.timeoutVal.textContent = parseFloat(dom.timeoutSlider.value).toFixed(1) + 's';

    /* Total Packets */
    dom.totalSlider.addEventListener('input', () => {
      const n = parseInt(dom.totalSlider.value, 10);
      cfg.totalPackets = n;
      dom.totalVal.textContent = n;
      if (!isRunning) {
        global.GBN.reset();
        global.SR.reset();
      }
    });
    dom.totalVal.textContent = dom.totalSlider.value;
  }

  /* =========================================================
   * MIRROR DROPS TOGGLE
   * ========================================================= */
  function wireMirrorToggle() {
    dom.mirrorToggle.addEventListener('change', () => {
      E().SimConfig.mirrorDrops = dom.mirrorToggle.checked;
    });
  }

  /* =========================================================
   * PROTOCOL DONE EVENTS
   * Show comparison modal when both are done.
   * ========================================================= */
  function wireDoneEvents() {
    E().EventBus.on('gbn:done', (data) => {
      gbnDone = true;
      _checkBothDone(data, null);
    });
    E().EventBus.on('sr:done', (data) => {
      srDone = true;
      _checkBothDone(null, data);
    });
  }

  /* Stored stats for comparison */
  let _lastGbnStats = null;
  let _lastSrStats = null;

  E().EventBus.on('gbn:done', d => { _lastGbnStats = d && d.stats; });
  E().EventBus.on('sr:done', d => { _lastSrStats = d && d.stats; });

  function _checkBothDone() {
    if (!gbnDone || !srDone) return;

    // Both done – show comparison modal
    setTimeout(() => {
      _showComparisonModal();
      isRunning = false;
      dom.playBtn.textContent = '▶ Play';
      dom.playBtn.classList.remove('btn-pause');
      dom.playBtn.classList.add('btn-play');
    }, 800);
  }

  /* =========================================================
   * COMPARISON MODAL
   * ========================================================= */
  function _showComparisonModal() {
    if (!dom.compModal) return;

    // Fill in stats
    const g = _lastGbnStats || {};
    const s = _lastSrStats  || {};
    const total = E().SimConfig.totalPackets;

    const gEff = g.sent > 0 ? ((total / g.sent) * 100).toFixed(1) : '–';
    const sEff = s.sent > 0 ? ((total / s.sent) * 100).toFixed(1) : '–';

    const rows = [
      { label: 'Total Transmissions', gbn: g.sent ?? '–', sr: s.sent ?? '–' },
      { label: 'Retransmissions',     gbn: g.retransmissions ?? 0, sr: s.retransmissions ?? 0 },
      { label: 'ACKs Received',       gbn: g.acksReceived ?? '–', sr: s.acksReceived ?? '–' },
      { label: 'Efficiency',          gbn: gEff + '%', sr: sEff + '%' },
    ];

    const tbody = document.getElementById('comp-tbody');
    if (tbody) {
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td>${r.label}</td>
          <td class="comp-gbn">${r.gbn}</td>
          <td class="comp-sr">${r.sr}</td>
        </tr>
      `).join('');
    }

    dom.compModal.classList.remove('hidden');
  }

  /* =========================================================
   * BUTTON WIRING
   * ========================================================= */
  function wireButtons() {
    dom.playBtn.addEventListener('click', togglePlay);
    dom.resetBtn.addEventListener('click', resetAll);

    if (dom.compClose) {
      dom.compClose.addEventListener('click', () => {
        dom.compModal.classList.add('hidden');
      });
    }

    // Close modal on backdrop click
    if (dom.compModal) {
      dom.compModal.addEventListener('click', (e) => {
        if (e.target === dom.compModal) dom.compModal.classList.add('hidden');
      });
    }
  }

  /* =========================================================
   * BOOT
   * ========================================================= */
  document.addEventListener('DOMContentLoaded', () => {
    grabDom();
    initProtocols();
    wireSliders();
    wireMirrorToggle();
    wireDoneEvents();
    wireButtons();

    console.log('%c🚀 CN Arena ready. Click Play to start.', 'color:#4f9cf9;font-weight:bold;font-size:14px');
  });

})(window);
