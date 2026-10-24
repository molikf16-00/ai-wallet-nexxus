# Nexus — Autonomous Agent Smart Account

> Enterprise-grade, defense-in-depth smart account architecture for autonomous AI agents, built on **ERC-4337 v0.7** and **ERC-7579** (Minimal Modular Accounts).

---

## Overview

Delegating raw private keys (EOA) to autonomous AI agents poses catastrophic financial and operational risk. If an agent's private key is leaked or manipulated via prompt injection, 100% of the account's assets can be drained in a single transaction.

**Nexus** solves this by enclosing AI agents within 4 concentric layers of deterministic on-chain protection:
1. **Ring 1: Scoped Session Keys (EIP-712)** — Ephemeral keys limited to pre-approved smart contract methods with temporal expiry.
2. **Ring 2: Bounded Policy Engine (ERC-7579 Hook Type 4)** — Strict programmatic single-transaction caps (`0.05 ETH`) and rolling 24-hour spend limits (`0.25 ETH`).
3. **Ring 3: Anomaly Sentinel & Circuit Breaker** — Exponentially Weighted Moving Average (EWMA) burst detector that automatically halts execution upon suspicious transaction clustering.
4. **Ring 4: 3-of-5 Guardian Social Recovery** — Hardware and cold-storage guardian recovery cluster with a mandatory 48-hour timelock and instant owner veto buffer.

---

## System Architecture

```
                  ┌──────────────────────────────────────────────┐
                  │          Autonomous AI Agent Process         │
                  └──────────────────────┬───────────────────────┘
                                         │ Signs UserOp with Ephemeral Key
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │             EntryPoint v0.7 Core             │
                  │        • 2D Nonce Key Replay Isolation       │
                  │        • EIP-712 Session Key Validation      │
                  └──────────────────────┬───────────────────────┘
                                         │
                        ┌────────────────┴────────────────┐
                        ▼                                 ▼
             ┌─────────────────────┐           ┌─────────────────────┐
             │ Paymaster Gas Quota │           │ ERC-7579 Hook Type 4│
             │   (500k Gas/Day)    │           │  NexusPolicyHook    │
             └─────────────────────┘           └──────────┬──────────┘
                                                          │ Pre-Check:
                                                          │ • Amount ≤ 0.05 ETH
                                                          │ • Daily ≤ 0.25 ETH
                                                          │ • Target in Calldata Allowlist
                                                          ▼
                                               ┌─────────────────────┐
                                               │ Vault Execution     │
                                               │ (Target Contract)   │
                                               └──────────┬──────────┘
                                                          │ Post-Check:
                                                          │ • Update rolling spend slot
                                                          ▼
                                               ┌─────────────────────┐
                                               │ Final Settlement    │
                                               └─────────────────────┘
```

---

## Repository Structure

```
├── contracts/               # Verified Solidity smart contracts
│   ├── NexusAccount.sol     # ERC-4337 + ERC-7579 modular account core
│   ├── NexusPolicyHook.sol  # Type 4 pre/post execution policy hook
│   ├── NexusRecovery.sol    # 3-of-5 guardian recovery with 48h timelock
│   └── AnomalyShield.sol    # EWMA z-score burst anomaly detector
├── dashboard/               # Standalone worker & simulator assets
│   └── fuzz-worker.js       # In-browser WebWorker mutation fuzzer
├── scripts/                 # Compilation & local simulation servers
│   ├── compile.ts           # Solc compiler script
│   └── dashboard-server.ts  # Local static & API development server
├── src/                     # Core backend models, invariants & simulators
├── tests/                   # Comprehensive empirical test suites
│   ├── attack-suite.test.ts # 6 adversarial penetration vectors
│   ├── anomaly-guard.test.ts# ROC anomaly curve benchmarks
│   ├── guardian-recovery.test.ts # Quorum, timelock & veto invariants
│   └── simulator.test.ts    # UserOp execution simulator
└── web/                     # React + Vite + TailwindCSS frontend
    ├── index.html           # HTML entry point with typography
    ├── public/              # Static assets (fuzz-worker.js)
    └── src/
        ├── App.tsx          # Full dashboard UI with interactive rings & pipeline
        └── styles.css       # Tailwind design tokens
```

---

## Getting Started

### Prerequisites

- **Node.js**: `v20.0.0` or higher
- **npm** or **pnpm**

### Installation

```bash
# Clone the repository
git clone https://github.com/<your-username>/nexus-wallet.git
cd nexus-wallet

# Install dependencies
npm install
```

### Running Locally

```bash
# Build the frontend dashboard
npm run build

# Start the full dashboard server (UI + API simulation on port 4173)
npm run dashboard
```
Open [http://127.0.0.1:4173](http://127.0.0.1:4173) in your browser.

---

## Automated Verification & Test Suites

Nexus enforces zero-assumption empirical verification:

```bash
# 1. Run 6 Adversarial Attack Containment Tests
npm run test:attacks

# 2. Run Anomaly Benchmark & ROC Invariant Tests
npm run test:anomaly

# 3. Run 3-of-5 Guardian Social Recovery Tests
npm run test:recovery

# 4. Run Core Execution Simulator Tests
npm test

# 5. Typecheck Entire Codebase (Backend + Web)
npm run typecheck
```

---

## Deployment on Vercel

This repository includes a native [`vercel.json`](./vercel.json) configuration:

```bash
# Deploy to preview
npx vercel

# Deploy to production
npx vercel --prod
```

Or connect the GitHub repository directly to Vercel via the Vercel Dashboard:
- **Framework Preset**: Vite
- **Root Directory**: `./`
- **Build Command**: `npm run build`
- **Output Directory**: `web/dist`

---

## License

MIT License. Designed for secure autonomous AI financial agency.
