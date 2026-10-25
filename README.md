# Nexus wallet workspace

A browser-based demonstration of guarded agent payments, attack simulations, anomaly detection, guardian recovery, and randomized verification. The dashboard does not connect to a wallet or broadcast transactions.

## Start

Use Node 20 or later.

- `npm ci`
- `npm run check` — all nine test suites, TypeScript checks, contract compilation, and production build.
- `npm run frontend:dev` — frontend development.
- `npm exec vite -- preview --host 127.0.0.1` — test the static production build.
- `npm run dashboard` — local frontend plus optional AI endpoint on port 4173.

Build once before starting frontend development so that `web/public/contracts.json` is generated.

## What works without a backend

- Security lab executes the existing six TypeScript attack fixtures, retaining pass/fail results and displaying the selected trace. Each fixture has its own limits.
- Anomaly Shield runs a synthetic 1,000-pattern benchmark in a module worker. Its curve and timing are calculated from results.
- Recovery is isolated to the browser tab: propose a valid replacement address, simulate three guardian approvals, advance the 48-hour clock, then execute; the owner can veto an active/pending proposal.
- Verification runs bounded randomized checks in a worker, supports cancellation and an intentionally flawed mode, and renders counterexamples safely.
- Contracts displays source and ABI exported from the current compilation.
- Agent tasks creates explicit payment plans, checks approved recipients and bigint spending limits, requires confirmation, rechecks current policy, and records completion/cancellation. Duplicate confirmations cannot debit the demo allowance twice.

Demo state resets on reload. There is no real daily clock, wallet balance, gas sponsorship, blockchain receipt, guardian signature, or deployed-contract verification. The agent and attack fixtures are separate simulations.

## Intent-driven architecture

Request → interpretation → structured payment plan → deterministic policy checks → user confirmation → policy recheck → simulation result and activity history.

The planner supports a single ETH payment to an explicit address or the Inference API / Cloud GPU service. Missing amounts or recipients require a new, complete request. Unsupported operations such as swaps, recurring payments, and permission changes are not executed.

The state machine is in `src/intent-agent.ts`. Payment execution is currently a simulated allowance debit, not an EVM transaction. A production execution adapter would need wallet authentication, signed approvals, durable per-user state, network-aware receipts, and on-chain enforcement.

## Optional AI interpretation

The app uses its local parser by default. To enable broader wording on Vercel, configure these **server-only** environment variables:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`: a model available to your account that supports Responses structured outputs
- `ENABLE_AI_PLANNER=true`

Do not use a `VITE_` prefix for secrets. Configure deployment access controls, provider spending limits, and endpoint rate limiting before enabling the public paid endpoint. The local demo itself needs no API key.

The browser discovers availability through `GET /api/intent`. Users explicitly select AI interpretation before their request text is sent. `POST /api/intent` returns a structured proposal or clarification, with bounded input, timeout, provider-error handling, and runtime validation. It has no wallet keys or execution tools. The proposal always passes through the same local policy engine and user confirmation.

Provider schema: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

The automated API suite uses a mocked provider. A real provider call requires the server configuration above and was not exercised during this change.

## Deploy

Vercel builds with `npm run build` and serves `web/dist`. The build compiles Solidity, exports source/ABI JSON, and builds the frontend and worker. `api/intent.ts` is the optional serverless endpoint; the remaining features need no server.

No private keys or secret environment files belong in the repository.

## Verification boundaries

The TypeScript suites cover simulator, attacks, anomaly, recovery, fuzzing, agent state transitions, the optional API, and browser-worker payloads. Solidity source compiles successfully. Foundry is not installed in the current environment, so its invariant test was not executed. Compilation and passing model tests are not a security audit of the Solidity contracts.

## Conversational copilot

The **Ask Copilot** button is available on every page. Its chat history stays available while navigating within the current tab. It can:

- Explain the page you are viewing and guide you to spending rules, recovery, verification, contracts, or security checks.
- Read the current demo allowance, pause state, and recent task outcomes.
- Ask for a missing payment amount or recipient, and offer a button to create a plan for review.
- Hand payment proposals to the same policy-checked Agent tasks flow. Chat cannot confirm or execute a payment.

Without AI configuration, the panel clearly identifies itself as a built-in guide with a bounded set of supported questions. With the existing server-only AI settings enabled, users can opt into AI chat. This sends up to 12 recent messages and a limited demo context snapshot to `POST /api/copilot`. The endpoint validates inputs, uses structured output, handles provider errors/timeouts, and has no execution tools. Use the same deployment access/rate-limit controls described above for this endpoint.

`npm run test:copilot` checks contextual guidance, follow-up payment planning, unsupported/unsafe action boundaries, input validation, and mocked provider responses.

