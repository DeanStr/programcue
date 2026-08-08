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
- The dependency-free evaluator in `public/` uses seeded data and browser `localStorage`. The Worker, D1 migration and domain modules form a smaller production foundation. Do not present evaluator behavior, static screens, schema tables or dry runs as completed production features.
- Never fabricate external-provider success. Clearly label simulations and dry runs. Missing credentials, bindings or required invariants must fail fast with a specific error.
- Do not add silent provider, storage, credential, stale-data or default fallbacks merely to keep an operation appearing successful.
- Do not overengineer. Add indirection only for a concrete current need; avoid speculative extension points, compatibility layers, microservices and generic frameworks.

## Implementation rules

- Keep deterministic business rules out of rendering handlers when practical; place them in `src/domain/` with focused tests.
- Preserve the zero-install evaluator unless an explicit architecture decision changes it. Do not add evaluator runtime dependencies casually.
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

Run the smallest relevant checks during development, then run:

```bash
npm run check:core
```

When Python Playwright and Chromium are available, also run `npm run check`. If the browser check cannot run, report that explicitly rather than claiming the full suite passed.

For user-facing changes, exercise the real browser workflow when possible and update `scripts/browser_check.py` as needed. For Worker/API changes, update tests and keep `docs/openapi.yaml` and `public/openapi.json` synchronized.

## Documentation

- Keep `README.md` concise and current.
- Update `docs/IMPLEMENTATION_STATUS.md` when implementation evidence changes materially.
- Distinguish **working evaluator**, **production subset**, **schema only**, **demonstration only** and **not implemented**.
- Avoid new status-report documents; update the existing audit.
- Do not edit the specification to make implementation appear more complete. Record progress in the implementation audit.
