# Program Cue contributor guidance

## Sources of truth

- Read `README.md` for the project overview and development commands.
- Treat `sessionboard-replacement-full-scope-implementation-specification-with-competition-ux.md` as the canonical product specification.
- Check `docs/IMPLEMENTATION_STATUS.md` before claiming a requirement is complete; it records verified evidence and remaining gaps.
- Record durable product or engineering decisions in `docs/DECISIONS.md`.

## Working principles

- Be concise, direct and candid. Challenge weak assumptions and distinguish verified facts from uncertainty.
- Ask questions only when a decision is materially ambiguous, risky, changes scope or requires approval. Otherwise, make a reasonable documented assumption and proceed.
- Keep changes focused and simple. Avoid speculative abstractions, generalized frameworks and unrelated cleanup.
- Test observable behavior rather than implementation trivia. Validate user-facing work in the real interface when applicable.
- Prefer the smallest design that satisfies the current requirement and leaves a clear path for later change.

## Product and architecture boundaries

- This project is pre-release. Backward compatibility is unnecessary unless a documented external consumer, deployed dataset or migration history requires it. Prefer a clean direct change over compatibility shims, dual paths or deprecated aliases.
- The application is one React Router/TypeScript modular monolith on Cloudflare Workers. D1-backed route behavior is production behavior; visually ported routes without connected services remain frontend foundation only. Do not present static screens, schema tables or dry runs as completed production features.
- Never fabricate external-provider success. Clearly label simulations and dry runs. Missing credentials, bindings or required invariants must fail fast with a specific error.
- Do not add silent provider, storage, credential, stale-data or default fallbacks merely to keep an operation appearing successful.
- Do not overengineer. Add indirection only for a concrete current need; avoid speculative extension points, compatibility layers, microservices and generic frameworks.

## Implementation rules

- Keep deterministic business rules out of rendering handlers when practical; place new rules in the relevant `app/modules/` domain or service layer with focused tests.
- Use React Router framework-mode route modules, TypeScript, server loaders/actions and the existing Program Cue design tokens. Do not introduce another client runtime or browser-local source of truth.
- Enforce production authorization and validation server-side. Hiding a UI control is not authorization.
- Preserve organisation and event isolation in every private production query and mutation.
- Persist durable intent before enqueueing external work and require idempotency for retryable operations.
- Revalidate blocking schedule conflicts at publication boundaries.
- Limit public programme endpoints to published data.
- Treat uploaded files as private. Do not claim upload completion when only local filename metadata was stored.
- While no deployed migration history exists, prefer updating the pre-release baseline schema directly. Once a migration has been deployed or shared as an immutable baseline, add a new numbered migration instead.
- Keep consequential actions explicit: show affected records or material changes, require confirmation and report honest progress and results.
- Provide keyboard alternatives for pointer-only interactions and preserve focus after dialogs close.

## Validation

Run the smallest relevant checks during development and before completing an
ordinary change. Prefer the directly affected unit or Worker files, or
`npm run test:changed`, plus `npm run typecheck:generated`. Run
`npm run typecheck` instead when route types, Worker bindings or generated
types may have changed. `npm run check:focused` combines incremental
TypeScript validation with tests affected by changes since the local `main`
branch, including staged and unstaged changes.

For user-facing changes, exercise the affected real browser workflow and run
the relevant Playwright spec when applicable. Update Playwright behavior or
visual coverage when the observable contract changes. A user-facing change
does not by itself require the complete repository gate.

Run `npm run check:core` for cross-cutting runtime, schema, authorization,
configuration or validation-runner changes. Run `npm run check` once for a
release or merge candidate when Chromium is available. For Worker/API changes,
update tests and keep `docs/openapi.yaml` and `public/openapi.json`
synchronized.

Documentation-only changes may use focused validation. Report any required checks that were not run and why; never claim the full suite passed when the browser check did not run.

## Documentation

- Keep `README.md` concise and current.
- Update `docs/IMPLEMENTATION_STATUS.md` when implementation evidence changes materially.
- Distinguish **production slice**, **frontend foundation**, **schema only**, **demonstration only** and **not implemented**.
- Avoid new status-report documents; update the existing audit.
- Do not edit the specification to make implementation appear more complete. Record progress in the implementation audit.
