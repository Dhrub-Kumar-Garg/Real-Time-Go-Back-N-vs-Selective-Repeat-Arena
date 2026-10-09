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
├── engine.js      # Shared simulation infrastructure: EventBus, SimClock (rAF + dt), SimConfig, Packet model
├── gbn.js         # Go-Back-N protocol logic: cumulative ACKs, timer gauge, drop loss & timeout recovery
├── sr.js          # Selective Repeat protocol logic: individual ACKs, out-of-order buffer (loss coming in Phase 3)
├── main.js        # UI wiring: global controls, sliders, event orchestration, comparison modal
└── README.md      # Project documentation and viva quick-reference
```

---

## ⚡ Phase 2: Go-Back-N Packet Loss & Recovery

In this phase, full interactive packet-loss and recovery mechanics are implemented for **Go-Back-N**:

### 1. Click-to-Drop Interaction
- Any **DATA packet** in flight in the GBN arena is clickable with an expanded hit target.
- Clicking drops the packet in transit: it triggers an immediate **✕ LOST** red burst and is removed from the network channel. It never reaches the receiver.
- Any **ACK packet** is also clickable to drop: demonstrates that **cumulative ACKs** make GBN resilient to lost ACKs when subsequent ACKs arrive in time.
- All drops increment the live **Lost** stat counter.

### 2. Textbook-Correct GBN Sender Logic (Kurose & Ross)
- **Single Logical Timer**: A countdown timer protects the oldest unACKed packet (`base`).
- **Dynamic Visual Gauge**: A live timer bar on the Sender box drains continuously in simulation time, turning from blue to amber and pulsing red near expiration.
- **Timer Rules**:
  - Starts when `base` is transmitted.
  - Restarts when `base` advances (if there are still unACKed packets in flight).
  - Stops when `base == nextSeq` (all sent packets have been acknowledged).
- **Timeout Retransmission**:
  - When the timer expires, the sender retransmits **all packets in the current window** (`[base..nextSeq - 1]`) in order.
  - Retransmitted packets are styled in **amber** with an explicit **`RETX`** tag.
  - A prominent toast banner appears: `⚠️ TIMEOUT on packet X — Go-Back-N resending [X..Y]` and the sender box pulses with an amber glow.
  - The sender timer restarts immediately for the resubmitted window.

### 3. Textbook-Correct GBN Receiver Logic
- Maintains `expectedSeq`.
- **In-Order Arrival**: If packet sequence matches `expectedSeq`, it is delivered, `expectedSeq` advances, and a green cumulative ACK is sent.
- **Out-of-Order Arrival**: If an earlier packet was lost, all subsequent packets arriving at the receiver are **visibly discarded** (purple-grey fade animation and discard alert).
- The receiver re-sends a **duplicate cumulative ACK** for the last in-order received packet (`expectedSeq - 1`). If no packet has been delivered yet, no ACK is generated.

---

## 🎓 Viva Demonstration Walkthrough

Follow this step-by-step demo during a viva or presentation:

1. **Initial Setup**: Keep default settings ($W=4$, 12 packets, Speed 1.0x, Timeout 3.0s). Click **▶ Play**.
2. **Induce Packet Loss**: While packets `0, 1, 2, 3` are traveling across the top lane, click packet **1** to drop it.
3. **Observe Receiver Discard**:
   - Packet **0** arrives, is accepted, and triggers **ACK 0**.
   - Packet **1** was lost in transit.
   - Packets **2** and **3** reach the receiver out of order: both are discarded, flashing the discard alert, and triggering **duplicate ACK 0**.
4. **Observe Sender Timeout & Recovery**:
   - The Sender's Base Timer drains and expires.
   - The toast banner announces: `TIMEOUT on packet 1 — Go-Back-N resending [1..3]`.
   - The sender window cells turn amber, and packets `1, 2, 3` are resent in amber with `RETX` badges.
   - Upon arrival at the receiver, packet `1` is accepted (`expectedSeq` advances to 2), then `2` is accepted, then `3`, and the transfer resumes smoothly to completion!

---

## 🧠 Key Theoretical Concepts (Viva Prep)

| Concept | Go-Back-N (GBN) | Selective Repeat (SR) |
| :--- | :--- | :--- |
| **ACK Type** | Cumulative: `ACK(n)` acknowledges all packets up to sequence `n`. | Individual: `ACK(n)` acknowledges only packet `n`. |
| **Receiver Buffering** | Discards out-of-order packets. Accepts only `expectedSeq`. | Buffers out-of-order packets in a receive window and flushes in-order prefixes. |
| **Sender Window Size ($W$)** | Up to $2^m - 1$ where $m$ is sequence bit width. | Up to $2^{m-1}$ to prevent sequence number ambiguity between old and new windows. |
| **Retransmission Scope** | Retransmits the entire window starting from the oldest unACKed packet. | Retransmits *only* the specific timed-out packet. |
| **Timer Count** | 1 logical timer (for `base`). | 1 timer per unACKed packet. |
| **Receiver Window** | Size = 1. | Size = Sender Window ($W$). |

---

## 🎨 Color-Coded Semantic Visual Language

- 🔵 **Blue**: First-transmission DATA packet in flight
- 🟢 **Green**: Cumulative ACK packet returning to sender
- 🟡 **Amber**: Retransmitted DATA packet with `RETX` tag / Timeout countdown
- 🔴 **Red**: Dropped packet / timer critical warning
- 🟣 **Purple-Grey**: Out-of-order discarded packet at receiver
