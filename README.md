# Real-Time Go-Back-N vs. Selective Repeat Arena

> **Computer Networks — Module 3: Data Link Layer (Sliding-Window Flow Control)**  
> An interactive, side-by-side animated simulator comparing the **Go-Back-N (GBN)** and **Selective Repeat (SR)** protocols under identical channel conditions.

---

## 🚀 How to Run

1. **No build step, no npm, no external server required.**
2. Simply double-click [`index.html`](file:///Users/arushipahuja/coding/cn_project/index.html) or open it with any modern web browser (Chrome, Edge, Safari, Firefox).
3. Alternatively, serve with any local HTTP server:
   ```bash
   npx serve .
   # or
   python3 -m http.server 8000
   ```

---

## 📂 File Structure

```text
cn_project/
├── index.html     # Semantic layout: header, legend, dual arenas, controls bar, comparison modal
├── styles.css     # Design system: dark glassmorphism theme, CSS tokens, animations, responsive rules
├── engine.js      # Shared simulation infrastructure: EventBus, SimClock (rAF + dt), SimConfig, Packet model
├── gbn.js         # Go-Back-N protocol logic: cumulative ACKs, in-order delivery, sender window
├── sr.js          # Selective Repeat protocol logic: individual ACKs, out-of-order buffer, prefix delivery
├── main.js        # UI wiring: global controls, sliders, event orchestration, comparison modal
└── README.md      # Project documentation and viva quick-reference
```

---

## 🧠 Key Theoretical Concepts (Viva Prep)

| Concept | Go-Back-N (GBN) | Selective Repeat (SR) |
| :--- | :--- | :--- |
| **ACK Type** | Cumulative: `ACK(n)` acknowledges all packets up to sequence `n`. | Individual: `ACK(n)` acknowledges only packet `n`. |
| **Receiver Buffering** | Discards out-of-order packets. Accepts only `expectedSeq`. | Buffers out-of-order packets in a receive window and flushes in-order prefixes. |
| **Sender Window Size ($W$)** | Up to $2^m - 1$ where $m$ is sequence bit width. | Up to $2^{m-1}$ to prevent sequence number ambiguity between old and new windows. |
| **Retransmission Scope** | Retransmits the entire window starting from the oldest unACKed packet. | Retransmits *only* the specific timed-out packet. |
| **Receiver Window** | Size = 1. | Size = Sender Window ($W$). |

---

## 🎨 Design System & Features

- **Dark Glassmorphism Theme**: Deep navy background with subtle glows, custom typography, and modern micro-animations.
- **Color-Coded Semantic Visual Language**:
  - 🔵 **Blue**: Data packets in flight
  - 🟢 **Green**: ACKs returning to sender
  - 🟣 **Purple**: Out-of-order buffered packets in the SR receive array
  - 🟡 **Amber**: Retransmissions / timeouts (Phase 2 ready)
  - 🔴 **Red**: Dropped / lost packets (Phase 2 ready)
- **Time-Based Animation**: Uses `requestAnimationFrame` with delta time ($\Delta t$). Speed changes and pausing work smoothly without stutter or broken `setTimeout` chains.
- **Dual Channel Pathways**: Separate upper and lower lanes for outbound data packets and returning ACKs with animated dashed flow lines.
- **Interactive Global Controls**:
  - **Play / Pause**: Starts or freezes the simulation clock simultaneously for both arenas.
  - **Reset**: Restores arenas, stats, logs, and windows to the initial state.
  - **Window Size ($W$) Slider** (1–7): Live-updates sender and receiver sliding windows.
  - **Speed Slider** (0.5x–2.0x): Dynamically scales time progression.
  - **Timeout Slider** (1.0s–6.0s): Sets retransmission deadline.
  - **Total Packets Slider** (4–20): Configures total payload sequence.
  - **Mirror Drops Toggle**: Pre-wired switch for synchronized failure comparison in Phase 2.
- **Real-Time Analytics & Modal**: Per-arena live counters for Sent, Retransmissions, ACKs, and Efficiency, plus an end-of-transfer comparison summary modal.
