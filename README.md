# Real-Time Go-Back-N vs. Selective Repeat Arena

> **Computer Networks — Module 3: Data Link Layer (Sliding-Window Flow Control)**  
> An interactive, side-by-side animated simulator comparing the **Go-Back-N (GBN)** and **Selective Repeat (SR)** protocols under identical channel conditions.

---

## 🚀 How to Run

1. **No build step, no npm, no external server required.**
2. Simply double-click [`index.html`](file:///Users/arushipahuja/coding/cn_project/index.html) or open it with any modern web browser (Chrome, Edge, Safari, Firefox).
3. Alternatively, serve with any local HTTP server:
   ```bash
   python3 -m http.server 8000
   ```

---

## 📂 File Structure

```text
cn_project/
├── index.html     # Semantic layout: header, legend, dual arenas, controls bar, comparison modal
├── styles.css     # Design system: dark glassmorphism theme, CSS tokens, animations, responsive rules
├── engine.js      # Shared simulation infrastructure: EventBus, SimClock (rAF + dt), SimConfig, Packet model, dropPacketVisual
├── gbn.js         # Go-Back-N protocol logic: cumulative ACKs, single base timer gauge, drop loss & window recovery
├── sr.js          # Selective Repeat protocol logic: individual ACKs, per-packet timers, receiver buffer & flush, selective recovery
├── main.js        # UI wiring: global controls, sliders, event orchestration, comparison modal
└── README.md      # Project documentation, viva quick-reference, and comparison guide
```

---

## ⚡ Protocol Implementation Details

### Go-Back-N (GBN) Mechanics
- **Cumulative ACKs**: `ACK(n)` acknowledges all packets up to sequence $n$.
- **Single Base Timer**: One logical timer monitors the oldest unACKed packet (`base`).
- **Receiver Discard**: Discards all out-of-order arrivals; re-sends duplicate cumulative ACK for the last in-order packet.
- **Window Retransmission**: On timeout of `base`, retransmits the entire window $[base..nextSeq-1]$ in order.

### Selective Repeat (SR) Mechanics (Phase 3)
- **Individual ACKs**: `ACK(n)` acknowledges *only* packet $n$ without cumulative side effects.
- **Independent Per-Packet Timers**: Every unACKed packet in flight maintains its own independent timer running in simulation time (scales with Speed and freezes on Pause).
- **Per-Cell Visual Timer Gauges**: Each window cell displays an independent mini timer bar that drains smoothly and turns amber/red near expiry. Cells ahead of a gap turn solid green (`ACKed`) while earlier cells are still waiting.
- **Receiver Buffering**: Out-of-order packets falling inside receiver window $[rcvBase..rcvBase + W - 1]$ are stored in the visual Receive Buffer (purple chips), leaving earlier missing slots visibly empty (dashed outline).
- **In-Order Buffer Flush**: When the missing gap arrives at `rcvBase`, the receiver flushes all consecutive buffered packets in order to the delivered strip, displaying a notification toast (e.g. `Packet 1 arrived — delivered 1, 2, 3 in order`), and slides `rcvBase`.
- **Selective Retransmission**: On timeout of packet $n$, the sender retransmits **only** packet $n$ (amber, `RETX` badge) and restarts only its timer.
- **Duplicate Delivery Prevention**: If an ACK is lost and packet $n \in [rcvBase - W..rcvBase - 1]$ is resent, the receiver immediately re-sends `ACK(n)` without buffering or delivering it again.

---

## 📊 Go-Back-N vs. Selective Repeat Comparison Table

| Metric / Feature | Go-Back-N (GBN) | Selective Repeat (SR) |
| :--- | :--- | :--- |
| **ACK Semantic** | **Cumulative**: `ACK(n)` acknowledges all packets $\le n$. | **Individual**: `ACK(n)` acknowledges *only* packet $n$. |
| **Receiver Buffering** | **None**: Out-of-order packets are discarded immediately. | **Yes**: Out-of-order packets are buffered until gaps fill. |
| **Timer Architecture** | **1 Logical Timer** running for the oldest unACKed packet (`base`). | **$N$ Independent Timers**, one per unACKed packet in flight. |
| **Retransmission Scope** | Retransmits **all packets** in current window $[base..nextSeq-1]$. | Retransmits **only the single lost packet**. |
| **Bandwidth Efficiency under Loss** | Lower (redundant retransmissions consume channel bandwidth). | **Higher** (only genuinely lost packets are retransmitted). |
| **Receiver Complexity** | Simple (only tracks `expectedSeq`). | Moderate (maintains buffer map, window bounds, and delivery prefix). |
| **Maximum Window Size** | $W \le 2^m - 1$ ($m$ sequence bit width). | $W \le 2^{m-1}$ (prevents overlap of old and new windows). |
| **Resilience to Lost ACKs** | High (subsequent cumulative ACK can acknowledge previous packets). | Requires re-ACKing already delivered packets upon retransmission. |

---

## 🎓 Viva Demonstration Walkthrough

Follow these scenarios during a live viva or professor demonstration:

### Scenario A: Selective Repeat Recovery vs. GBN Window Retransmission
1. Set Window Size to **4**, Total Packets to **12**, Speed to **1.0x**.
2. Click **▶ Play**.
3. While packets `0, 1, 2, 3` are in flight across both arenas, click **packet 1** in both arenas to drop it.
4. **Compare the outcomes**:
   - **In GBN**: Packet 0 delivers. Packets 2 and 3 arrive and are **discarded**. The timer on packet 1 expires, and GBN retransmits **all 3 packets** (`1, 2, 3`).
   - **In SR**: Packet 0 delivers. Packets 2 and 3 arrive and are **buffered in purple slots** (slot 1 stays dashed/empty). Individual ACKs 2 and 3 return to sender, turning cells 2 and 3 **green** while cell 1 remains blue/amber. Only packet 1's timer expires. The sender retransmits **ONLY packet 1**. When packet 1 arrives, the receiver delivers `1, 2, 3` in order, flushes the buffer, and sender base jumps directly to 4!
5. Notice that SR achieves higher efficiency and lower packet retransmission count.

### Scenario B: Lost ACK Resilience
1. In the SR arena, click an **ACK packet** (e.g. ACK 2) in flight to drop it.
2. Observe that sender times out on packet 2 and retransmits ONLY packet 2.
3. The receiver notices packet 2 is already delivered, sends an individual `ACK 2` again, and does **not** duplicate delivery.
4. The sender receives the re-ACK and marks packet 2 acknowledged.

---

## 🎨 Semantic Visual Language

- 🔵 **Blue**: First-transmission DATA packet in flight / in-flight sender window cell
- 🟢 **Green**: ACK packet returning to sender / acknowledged window cell
- 🟡 **Amber**: Retransmitted DATA packet with `RETX` tag / timeout countdown gauge & pulse
- 🔴 **Red**: Dropped packet with `✕ LOST` burst / critical timer state
- 🟣 **Purple**: Out-of-order buffered packet in SR Receive Buffer / GBN discarded packet alert
