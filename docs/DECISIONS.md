# Product and engineering decisions

| Decision | Outcome |
|---|---|
| Product name | Program Cue |
| Product shape | Single TypeScript modular monolith |
| Tenant model | One organisation with multiple events; event-scoped operational records |
| Admin navigation | Command Centre, Event Setup, Submissions, Review, Speakers, Schedule, Communications, Tasks, Programme, Integrations, Settings |
| Admin visual shell | Dark navigation, light work canvas |
| Participant/public density | Comfortable light surfaces |
| Canonical demo event | Future of Events 2025, 20–22 May 2025, Toronto |
| Primary repository | D1 relational model |
| Airtable | Optional explicit adapter/repository, never silent fallback |
| Person model | Canonical person identity with submission/session associations |
| Form publishing | Immutable published versions; edits create the next draft version |
| Evaluation | Weighted criteria, explicit conflict declaration, administrator decision authority |
| Schedule conflicts | Room and speaker conflicts block publication; policy can classify other constraints as warnings |
| Calendar baseline | Standards-compatible ICS; connected Google/Microsoft calendars are optional |
| Dashboard freshness | Mutation invalidation, focus refresh and bounded polling; no WebSocket dependency |
| AI/agent actions | Contextual planning, preview, approval, staging and audit; no direct unreviewed publish/send |
| Failure behaviour | Fail closed for missing auth/bindings/blockers; no hidden provider fallback |
| Excluded product scope | General CRM, general marketing automation, payments, multilingual and general-purpose CMS |
