# Real-Time Go-Back-N vs. Selective Repeat Arena

> **Computer Networks — Module 3: Data Link Layer (Sliding-Window Flow Control)**  
> An interactive, side-by-side animated simulator comparing the **Go-Back-N (GBN)** and **Selective Repeat (SR)** sliding-window protocols under identical channel conditions.

[![Self-Tests](https://img.shields.io/badge/Self--Tests-3%2F3%20Passing-emerald?style=flat-square)](#-in-browser-self-test-suite)
[![Pure Vanilla](https://img.shields.io/badge/Stack-HTML5%20%7C%20CSS3%20%7C%20JS%20(ES6)-blue?style=flat-square)](#-architecture--file-structure)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero%20(No%20npm%2C%20no%20build)-purple?style=flat-square)](#-how-to-run)

---

## 📸 Visual Showcase

| Dual Arena & Live Scoreboard | Guided Demo Mode & Narration | Final Result & Visual Benchmark |
| :---: | :---: | :---: |
| ![Dual Arena Overview](docs/screenshots/arena_scoreboard_overview.png) | ![Guided Demo Narration](docs/screenshots/guided_demo_narration.png) | ![Final Benchmark Modal](docs/screenshots/final_result_benchmark.png) |
| *Side-by-side arenas with live score counters & crowns* | *Deterministic 7-step narrated scenario with pause/next* | *Pure CSS comparison bar charts & advantage verdict* |

---

## 🌟 Key Features

1. **Side-by-Side Dual Arenas**
   - Real-time simulation of Go-Back-N and Selective Repeat operating in parallel.
   - Time-based physics clock (`requestAnimationFrame` with delta time $\Delta t$); smooth slider speed adjustment ($0.5\times$ to $2.0\times$) and pause/resume without drift.

2. **Synchronized Mirror Drops (Fair Comparison)**
   - Wire toggle **ON by default**. Dropping DATA packet $N$ in one arena automatically schedules and drops the exact same packet $N$ in the other arena with a linked red pulse and `LINKED` badge.
   - ACKs are not mirrored, allowing individual resilience tests.

3. **Live Comparison Scoreboard**
   - Sticky live dashboard between arenas comparing: **Total Transmissions**, **Retransmissions**, **Wasted Bandwidth** (discarded packets), **Completion Time**, **Channel Efficiency %**, and **Packets Lost**.
   - Dynamic crown indicators (👑) and checkmarks (✓) highlight the winning protocol in each row in real time.
   - Live dynamic verdict banner (e.g. *"Selective Repeat saved 5 transmissions (-38% link overhead) vs. Go-Back-N"*).

4. **Auto-Demo Mode (The Viva & Presentation Feature)**
   - Click **✨ Guided Demo** (or press key <kbd>D</kbd>) to run a scripted, deterministic 7-step narrated scenario ($W=4$, 12 packets, Mirror ON).
   - Explains each milestone in plain English on a narration bar: initial transmission $\to$ mirrored drop of packet 1 $\to$ out-of-order discard vs. buffer $\to$ timeout recovery $\to$ mid-stream loss of packet 6 $\to$ ACK loss resilience $\to$ completion verdict.
   - Interactive controls: **⏸ Pause**, **⏭ Next Step**, and **✕ Exit** to free play.

5. **Final Result Modal with Pure CSS Bar Charts**
   - Automatically displays when both arenas complete: overall winner banner, animated pure CSS visual horizontal bar charts for transmissions and simulation time, comprehensive metrics table, and a **↺ Run Again** button.

6. **Theory Explainer ("How It Works") & Presentation Mode**
   - Built-in theory modal with ASCII window diagrams and an 8-dimension GBN vs. SR textbook comparison table.
   - **Presentation Mode** (Key <kbd>P</kbd>): Enlarges packets ($48\text{px}$) and typography while hiding secondary UI for high-visibility projector displays.

7. **Synthesized Web Audio Effects**
   - Pure Web Audio API tone synthesis (zero external audio files) for packet send, ACK arrival, packet loss burst, and timeout alerts. Off by default with mute/unmute toggle (Key <kbd>S</kbd>).

8. **In-Browser Self-Test Suite**
   - Built-in headless verification runner (`window.runTests()` or button in shortcuts modal) asserting deterministic protocol behavior and printing PASS/FAIL to the browser console.

---

## 🚀 How to Run

1. **Zero installation, zero build steps, zero external dependencies.**
2. Double-click [`index.html`](file:///Users/arushipahuja/coding/cn_project/index.html) or open it directly in any modern browser (Chrome, Edge, Firefox, Safari).
3. Optionally, serve using Python's built-in HTTP server:
   ```bash
   python3 -m http.server 8000
   # Open http://localhost:8000 in your browser
   ```

---

## ⌨️ Controls & Keyboard Shortcuts

| Shortcut | Action | Description |
| :---: | :--- | :--- |
| <kbd>Space</kbd> | **Play / Pause** | Toggle simulation clock playback smoothly |
| <kbd>R</kbd> | **Reset** | Clear channels, zero counters, and restore initial state |
| <kbd>D</kbd> | **Guided Demo** | Start or exit the 7-step narrated viva walkthrough |
| <kbd>M</kbd> | **Toggle Mirror** | Turn synchronized cross-arena packet drops on or off |
| <kbd>P</kbd> | **Presentation Mode** | Enlarge fonts/packets ($48\text{px}$) for projector view |
| <kbd>S</kbd> | **Audio Effects** | Toggle synthesized Web Audio sound effects on/off |
| <kbd>?</kbd> | **Shortcuts Modal** | Open keyboard cheat-sheet and self-test panel |
| <kbd>Esc</kbd> | **Dismiss / Exit** | Close any open modal or exit active Guided Demo |

### Global Sliders
- **Window Size ($W$):** $1$ to $7$ (default: $4$) — dynamically adjusts sender & receiver window bounds.
- **Speed:** $0.5\times$ to $2.0\times$ (default: $1.0\times$) — simulation time scaling.
- **Timeout:** $1.0\text{s}$ to $6.0\text{s}$ (default: $3.0\text{s}$) — retransmission timer countdown.
- **Total Packets:** $4$ to $20$ (default: $12$) — total sequence numbers to transmit.

---

## ⚡ Protocol Implementation Rules

### 1. Go-Back-N (GBN)
- **Cumulative ACKs:** An `ACK(n)` acknowledges all packets $\le n$.
- **Single Base Timer:** Exactly one logical timer runs for the oldest unACKed packet (`base`). Visualized as an animated circular gauge inside the sender box.
- **Receiver Policy (Window = 1):** Discards any out-of-order packet ($seq \ne expectedSeq$) and re-sends duplicate `ACK(expectedSeq - 1)`.
- **Retransmission Scope:** On timeout of `base`, sender retransmits the **entire window** $[base \dots nextSeq - 1]$.
- **Wasted Bandwidth:** Increments on every out-of-order packet discarded by receiver.

### 2. Selective Repeat (SR)
- **Individual ACKs:** An `ACK(n)` acknowledges *strictly* packet $n$.
- **Independent Timers ($N$ Timers):** Every unACKed packet in flight maintains its own independent timer countdown in simulation time. Each window cell displays an independent mini timer bar.
- **Receiver Buffering (Window = $W$):** Out-of-order arrivals within $[rcvBase \dots rcvBase + W - 1]$ are stored in visual buffer slots (purple chips), leaving gaps empty (dashed borders).
- **In-Order Buffer Flush:** Once the missing sequence gap arrives, the receiver delivers all consecutive buffered packets in order to the delivered strip and advances $rcvBase$.
- **Selective Retransmission:** On timeout of packet $n$, sender retransmits **only packet $n$** (amber `RETX` badge) without affecting other packets.
- **Duplicate Prevention:** Already-delivered packets receiving duplicate retransmissions (due to lost ACKs) are immediately re-ACKed without duplicate delivery.

---

## 📊 Comprehensive GBN vs. SR Comparison Table

| Dimension | Go-Back-N (GBN) | Selective Repeat (SR) |
| :--- | :--- | :--- |
| **ACK Semantic** | **Cumulative**: `ACK(n)` confirms all packets $\le n$ | **Individual**: `ACK(n)` confirms strictly packet $n$ |
| **Receiver Window Size** | $1$ (no buffering capability) | $W$ (buffers packets in $[rcvBase \dots rcvBase + W - 1]$) |
| **Out-of-Order Policy** | **Discard immediately**; re-send duplicate ACK | **Store in buffer slot**; deliver prefix when gap fills |
| **Sender Timers** | **1 Logical Timer** for oldest unACKed packet (`base`) | **$N$ Independent Timers** (one per in-flight packet) |
| **Retransmission Scope** | **Entire Window** $[base \dots nextSeq - 1]$ | **Only the specific timed-out packet** |
| **Max Window Size** | $W \le 2^m - 1$ ($m$-bit sequence space) | $W \le 2^{m-1}$ (prevents old/new window ambiguity) |
| **Loss Bandwidth Efficiency** | **Lower**: Wastes capacity re-sending intact packets | **Higher**: Optimal link efficiency under loss |
| **Hardware / Memory Cost** | **Minimal**: Simple receiver state (`expectedSeq`) | **Moderate**: Requires receiver buffer & re-ordering |
| **Real-World Prototyping** | Embedded low-power sensors, legacy links | TCP Selective ACKs (SACK), Satellite channels |

---

## 🧪 In-Browser Self-Test Suite

The simulation includes a built-in automated test suite (`window.runTests()`) accessible from the browser console or the shortcuts modal (<kbd>?</kbd> $\to$ **Run Protocol Verification**):

1. **Test 1 — Recovery Scope ($W=4$, Drop Seq 1):**  
   Asserts that GBN retransmits $3$ packets ($[1, 2, 3]$) on timeout, while SR retransmits strictly $1$ packet ($seq=1$).
2. **Test 2 — Receiver Buffering & Wasted Bandwidth:**  
   Asserts that GBN registers $\ge 2$ wasted packets from out-of-order discards, while SR achieves $0$ wasted packets by buffering arrivals.
3. **Test 3 — Cumulative ACK Resilience in GBN:**  
   Asserts that dropping `ACK(0)` while `ACK(1)` arrives safely advances the sender base with $0$ timeouts incurred.

---

## 📂 Architecture & File Structure

```text
cn_project/
├── index.html     # Semantic layout: header, legend, dual arenas, live scoreboard, modals, footer
├── styles.css     # CSS custom properties, glassmorphism theme, animations, presentation overrides
├── engine.js      # Simulation core: EventBus, SimClock (rAF+dt), SimConfig, Sound, Packet model
├── gbn.js         # Go-Back-N implementation: cumulative ACKs, single base timer gauge, window recovery
├── sr.js          # Selective Repeat implementation: per-packet timers, buffer array & flush, selective retx
├── main.js        # Showcase layer: live scoreboard, auto-demo controller, presentation mode, runTests()
├── README.md      # Comprehensive documentation, viva guide & comparison table
└── docs/
    └── screenshots/  # Screenshot & GIF demonstration placeholders
```

---

## 🎯 Learning Outcomes (Module 3: Data Link Layer)

This project concretely demonstrates the fundamental trade-offs in Data Link Layer flow control:

1. **Bandwidth-Delay Product (BDP) Utilization:**  
   Why Stop-and-Wait is inefficient ($U \ll 1$) and how sliding-window pipelining fills the propagation channel with up to $W$ in-flight packets.
2. **Memory vs. Bandwidth Trade-Off:**  
   GBN minimizes receiver memory (zero buffer slots) at the cost of wasting network bandwidth on redundant retransmissions. SR preserves network bandwidth by investing receiver memory in buffering out-of-order packets.
3. **Window Size Bounds & Sequence Ambiguity:**  
   Why GBN requires $W \le 2^m - 1$ while SR requires $W \le 2^{m-1}$ to prevent receiver window overlap with the previous transmission cycle.
4. **Cumulative vs. Selective Acknowledgment:**  
   How cumulative ACKs provide inherent fault tolerance against lost ACKs, while selective ACKs isolate individual packet loss events without cascading timeouts.

---

## 👤 Author Information

- **Student Name:** Arushi Pahuja  
- **Roll Number:** 10  
- **Course:** Computer Networks (Module 3 — Data Link Layer: Sliding Window Protocols)  
