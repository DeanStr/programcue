# Security baseline

- Every event-scoped read/write must validate organisation membership and event role server-side.
- Public endpoints expose published programme data only.
- Administrative API routes require an authenticated session/token; hiding UI controls is not authorisation.
- Private files use opaque keys and short-lived signed access. Original filenames are metadata, not object paths.
- Uploads enforce MIME type, extension, size and ownership before becoming active.
- Public forms use rate limits and bot protection; final submission requires verified email by default.
- Provider credentials are secrets and never event form data.
- Consequential actions append audit events: decisions, schedule publication, form publication, bulk communication, integration sync, role changes and agent approvals.
- Bulk messages require recipient preview, suppression/invalid counts, validation and explicit confirmation.
- Schedule publication fails while unresolved blocking conflicts exist.
- Queued operations are idempotent and have bounded retry budgets. Non-idempotent operations do not automatically retry without a provider idempotency contract.
- Data retention and erasure workflows operate by event and person association while preserving legally required audit evidence.
