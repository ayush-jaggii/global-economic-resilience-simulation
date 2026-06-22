# Real-Time Global Economic Resilience Simulation

A production-grade, highly concurrent, and fault-tolerant multiplayer macroeconomic simulation system. Designed to host 30+ simultaneous team connections in a high-stakes, real-time strategy environment, this engine models a sovereign state's economic cycle (Assets $\rightarrow$ GDP Generation $\rightarrow$ Fiscal Revenue $\rightarrow$ Reinvestment $\rightarrow$ Growth).

## Authors & Creators
* **Ayush Jaggi**
* **Mohd Zain Peeradina**
* **Advait Sharma**
* **Khushi B Agarwal**

---

## System Architecture & Data Flow

The platform utilizes a centralized state-machine architecture with a decoupled client-server pattern. All transaction processing, mathematical validations, timers, and state mutations are executed strictly on the server to prevent client-side tampering.

```
                  ┌───────────────────────────────┐
                  │      Host / Admin Client      │
                  │   - Override commands         │
                  │   - State manipulation        │
                  └───────────────┬───────────────┘
                                  │ Full-Duplex WebSockets
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│                      Node.js Core Game Engine                     │
│                                                                   │
│  ┌───────────────────────┐             ┌───────────────────────┐  │
│  │  Atomic Bid Queuer    │             │  Idempotency Cache    │  │
│  │  - Virtual Mutex      ├────────────►│  - UUID v4 Deduplicator│  │
│  └───────────────────────┘             └───────────────────────┘  │
│                                                                   │
│  ┌───────────────────────┐             ┌───────────────────────┐  │
│  │  SHA-256 State Hasher │             │  Async JSON Backup    │  │
│  │  - Checksum validation│             │  - Recovery Log (3s)  │  │
│  └───────────────────────┘             └───────────────────────┘  │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │ Real-time Broadcaster
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│                       30+ Team Dashboards                         │
│   - Outbid notifications  - Ledger balances  - Local check-sync  │
└───────────────────────────────────────────────────────────────────┘
```

### Technology Stack
* **Backend:** Native Node.js HTTP server and full-duplex WebSocket protocol (`ws`) for sub-millisecond network latency and high packet throughput.
* **Frontend:** Responsive client applications built using Vanilla HTML5, CSS3 variables, and Javascript, utilizing modern glassmorphism UI design, live animations, and JetBrains Mono typography.
* **Storage & Recovery:** State serialization engine backing up the global game graph every 3 seconds to a JSON database.

---

## ⚡ Key Engineering Challenges & Technical Solutions

Executing a live multiplayer simulation for dozens of players simultaneously introduces complex problems in concurrency, state consistency, and networking. The simulation resolves these issues through the following mechanisms:

### 1. High-Concurrency Transaction Ordering (Virtual Mutex Queue)
* **The Problem:** In the final seconds of an auction phase, multiple teams frequently bid on the same asset or booster within milliseconds of each other. Naive parallel processing leads to race conditions, double-allocations, and state corruption.
* **The Solution:** The server implements an in-memory queueing router (`pendingAssetBidQueues` and `pendingBoosterBidQueues`). When a bid is received, the target asset is locked (`isProcessing = true`). Concurrent incoming bids on that asset are routed to a queue and resolved sequentially using `setImmediate()`, ensuring absolute transactional consistency.

### 2. Transaction Deduplication (Idempotency Engine)
* **The Problem:** Network instability or client double-clicks can cause duplicate HTTP/WebSocket requests, resulting in accidental double-spending of capital.
* **The Solution:** Every client bid is signed with a unique client-side UUID v4 (`bidId`). The server maintains a memory-mapped `bidIdempotencyCache` with a 2-minute Time-To-Live (TTL) garbage collector. If a retry with the same UUID is detected, the server immediately serves the cached transaction result rather than executing the bid logic again.

### 3. Checksum Verification & Self-Healing Sync (SHA-256 Checksums)
* **The Problem:** WebSocket packet loss or transient disconnection can cause client UI states (e.g., cash ledger, assets owned) to drift from the server's master state.
* **The Solution:** During every broadcast cycle, the server computes a SHA-256 hash of the critical game state variables (round number, phase, current asset prices, and team balances). The client computes the same checksum locally upon receiving payloads. If the client detects a checksum mismatch three times, it initiates a silent self-healing request (`REQUEST_STATE`) to pull the full master state.

### 4. Zero-Downtime Session Persistence
* **The Problem:** Server crashes or power drops during live events could ruin the tournament.
* **The Solution:** An active serialization scheduler writes the entire game graph to `backup.json` every 3 seconds. On startup, the server automatically reads and parses this backup, recovering the round, timer, active bids, team portfolios, and credentials without manual intervention.

### 5. Telemetry & Performance Monitoring
* The server runs a background diagnostics thread that measures average bid processing latency, database serialization time, sync failure rates, and WebSocket status. These metrics are formatted and printed every 10 seconds to log files and the server console for live administrative health checks.

---

## Economic Simulation Design & Algorithms

The engine models a complete macroeconomic cycle with complex allocation constraints, taxation, and asset depreciation math.

### 1. Macroeconomic Asset Modeling
Assets represent components of Gross Domestic Product ($GDP = C + I + G + (X - M)$):

| Sector | GDP Component | Macroeconomic Variable |
| :--- | :--- | :--- |
| **Food & Agriculture** | Consumption | $C$ |
| **Manufacturing** | Investment | $I$ |
| **Finance** | Government Spending | $G$ |
| **Trade & Logistics** | Net Exports | $X - M$ |

* **Portfolio Optimization Constraints:** To model realistic portfolio diversification, teams are restricted to a maximum of **5 assets total** and **no more than 2 assets per sector**.

### 2. Bidding & Liquidation Mechanics
* **Bidding Increments:** Bids must increase by a minimum of **₹0.5 Cr (50 Lakhs)**.
* **Capital Lockup:** Bidding capital is locked as `lockedCash`. When outbid, the system automatically releases the funds back to `availableCash` and pushes a targeted notification to the outbid team's screen.
* **Asset Depreciation Math:** When a team liquidates an asset to free up capital, it depreciates recursively based on the duration it was held:
  $$\text{Selling Price} = \text{Purchase Price} \times (1 - \text{Depreciation Rate} \times \text{Rounds Held})$$

### 3. Market Matching under Constraints (Overflow Reallocation)
* **The Problem:** In a sealed-auction settlement, a team may win bids on 3 assets in the same sector (violating the sector limit of 2) or exceed their 5-asset portfolio limit.
* **The Solution:** At the end of the auction phase, the server executes a settlement algorithm. If a team has won more assets than allowed, it is allocated the highest-bid assets. The excess assets are treated as *overflow* and recursively **reallocated** to the second-highest bidder in the asset's bidding history who satisfies all limits and holds enough capital.

### 4. Progressive Taxation & Fiscal Policy
To prevent leading teams from monopolizing resources and to keep the competition active, the system implements a progressive tax bracket based on current team rankings:

| Ranking Band | Tax Rate | Government Revenue Formula |
| :--- | :--- | :--- |
| **Top 10 Teams (Ranks 1–10)** | 20% | $\text{Average GDP} \times 0.20$ |
| **Middle 10 Teams (Ranks 11–20)** | 25% | $\text{Average GDP} \times 0.25$ |
| **Bottom 10 Teams (Ranks 21–30)** | 30% | $\text{Average GDP} \times 0.30$ |

$$\text{Revenue} = \text{Average GDP} \times \text{Tax Rate}$$

---

## Running the Project Locally

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Launch the Engine:**
   ```bash
   npm start
   ```
   The server will start on port `3000`.

3. **Client Access Ports:**
   * **Team Workspace:** `http://localhost:3000/team.html` (Secure authentication; credentials loaded from `team_credentials.csv`)
   * **Projector Leaderboard:** `http://localhost:3000/display.html` (High-contrast public display)
   * **Host Console:** `http://localhost:3000/host.html` (Manual overrides, pause/resume, and timer edits)
   * **Admin Terminal:** `http://localhost:3000/admin.html` (State overrides and hard resets)
