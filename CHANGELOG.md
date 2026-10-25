# Change and verification notes

## Root causes addressed

1. The Vercel deployment was static, but Security Lab, Anomaly Shield, recovery, and contracts fetched APIs only provided by the local development server. These features now run locally or load build-generated assets.
2. Copilot ignored user amounts, generated random transaction hashes, and reported settlement without execution. Replaced with a structured intent/task state machine and optional server-side AI interpretation.
3. Pause and spending controls were presentation-only. Pending tasks now recheck current pause state, approved recipients, transaction limit, and cumulative allowance before simulation.
4. Trace rows reused duplicate keys across attack runs. Rows now use scenario plus row position.
5. Anomaly containment time included training days. It now starts at the first evaluated input; chart and explanatory metrics use measured results.
6. Recovery accepted malformed replacement addresses. Validation now rejects invalid and zero addresses, and the UI disables premature finalization.
7. Verification claimed success before running, forwarded its worker to a missing local server, and crashed when rendering BigInt counterexamples. Fixed the initial state, static worker route, bounded input, cancellation, and serialization.
8. Compatible dependency updates and a patched tmp override remove all npm audit findings.

## Checks

- All original test suites passed before changes.
- Expanded automated checks: simulator, six attack scenarios, anomaly benchmark, recovery, fuzz engine, intent agent, mocked AI API, and public worker.
- TypeScript validation and Solidity compilation.
- Production frontend build.
- Browser smoke checks: plan/confirm payment; six attack runs; anomaly results; recovery quorum, timelock and finalization; 5,000 safe mutations; flawed-mode counterexample; contract source display.
- Mobile layout inspected at 390px.

## Limits

- Work is local; the GitHub repository and live Vercel deployment have not been updated.
- AI provider integration requires server environment configuration and a real-provider smoke test.
- Wallet operations remain simulations. No wallet connection, signing, or funds transfer is implemented.
- Foundry execution and a Solidity security audit remain outside the checks completed here.

## Conversational copilot addition

Added an always-available chat panel with contextual help, follow-up payment clarification, page navigation, current allowance/task explanations, and explicit creation of reviewable plans. Includes an optional structured-output chat endpoint, local guide mode, keyboard controls, new-chat reset, cancellation, retry, and duplicate-plan protection.

Validation: copilot unit/API tests, TypeScript checks, production build, and browser flows for allowance queries, follow-up payment planning, creating a task without execution, and updated allowance after a separately confirmed simulation. Real-provider calls still require server configuration.
