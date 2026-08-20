# Performance evidence

Program Cue keeps timing checks separate from the deterministic correctness gate because shared-runner load is not a product regression signal. Run the explicit Chromium harness against the freshly built local Worker with:

```bash
npm run performance:local
```

The command is opt-in and should run on a quiescent host. It builds once, then runs the explicitly selected baseline and scale profiles against separate freshly reset local Workers and D1 states. The scale fixture is applied while its Worker is stopped, avoiding unsupported concurrent writes to Miniflare's SQLite state. The normal correctness suite discovers the performance file but skips its timing assertions unless `PERFORMANCE_EVIDENCE=1`, avoiding hardware-dependent flakes and leaving demo/development data untouched.

The first case disables the browser cache for public navigation, applies a 4 Mbps down / 1 Mbps up / 80 ms latency mobile profile with 4× CPU throttling, and uses five cold public-navigation samples, twenty warmed admin-navigation samples and seven warmed interaction samples. It writes `performance-local.json` beneath the ignored Playwright `test-results/` directory.

The second case applies `e2e/fixtures/performance-scale.sql` only to its freshly reset database before the measurement Worker starts. The deterministic fixture adds exactly 10,000 non-draft submissions with valid immutable submitted snapshots, form-version routing and persisted track selections, 10,000 accepted speaker memberships, selective task/file states and a 200-session/199-entry schedule draft. It then:

- asserts the fixture cardinality before starting measurement;
- visits the real, server-paged submissions and speakers routes and takes five indexed-filter samples for each;
- performs five real Event Setup mutations, observes their post-commit WebSocket invalidations in a second page and restores the changed value;
- performs five real schedule placements through the route action against the representative schedule; and
- measures one browser-recovery save-state transition after editing the real form builder.

It writes `performance-scale-local.json` and fails on the applicable section 16.1 local budgets. This is deliberately a focused fixture and route harness, not a generic benchmark framework or demo seed.

## Latest local measurement

Measured 2026-08-20 with Playwright Chromium and the repository's Miniflare D1/R2 Worker:

| Measurement                                       | Local result |            Section 16 budget | Result       |
| ------------------------------------------------- | -----------: | ---------------------------: | ------------ |
| Public programme LCP, p75 of 5 cold navigations   |       908 ms |                  <= 2,500 ms | Pass locally |
| Public programme CLS, maximum of 5 navigations    |            0 |                       <= 0.1 | Pass locally |
| Public programme filter feedback, p75 of 7        |      48.5 ms | <= 200 ms interaction target | Pass locally |
| Command palette usable, p95 of 7                  |      37.2 ms |                    <= 100 ms | Pass locally |
| Event search response after debounce, p95 of 7    |      13.6 ms |                    <= 300 ms | Pass locally |
| Warmed admin route first useful heading, p95 of 20 |        68 ms |                    <= 100 ms | Pass locally |

## Scale and mutation measurement status

Measured 2026-08-20 with the isolated scale Worker and migrated schema:

| Measurement                                      | Local result | Section 16 budget | Result       |
| ------------------------------------------------ | -----------: | ----------------: | ------------ |
| Applications first useful page, 10,000 records   |     317.4 ms |      <= 1,500 ms | Pass locally |
| Applications indexed filter, p95 of 5            |     295.7 ms |        <= 500 ms | Pass locally |
| Speakers first useful page, 10,000 records       |     280.6 ms |      <= 1,500 ms | Pass locally |
| Speakers indexed filter, p95 of 5                |     335.6 ms |        <= 500 ms | Pass locally |
| Event Setup mutation response, p95 of 5           |       131 ms |        <= 750 ms | Pass locally |
| Schedule validation mutation, p95 of 5            |     203.8 ms |        <= 500 ms | Pass locally |
| Event change commit to visible invalidation, p95 |       901 ms |      <= 2,000 ms | Pass locally |
| Form-builder local autosave feedback             |       826 ms |      <= 2,000 ms | Pass locally |

Migration validation proves the named indexes exist. The measurements above exercise the real route and repository statements; they do not claim that a hand-written proxy query proves the production query plan. These are local lab results, not deployed scale or field-latency acceptance.

## Production data-locality correction

On 13 August 2026, retained production timing evidence isolated the dominant
latency source to the database region: a Melbourne command-centre data request
took 2,775 ms wall time while using only 33 ms of Worker CPU, and the event
change feed took 1,669 ms wall time with 20 ms of CPU. The production D1 primary
was in EEUR even though the intended users are primarily on the US West Coast.

Smart Placement is now enabled and the quiesced 2.22 MB production database was
cut over to a WNAM D1 primary. This removes Europe as the database round trip
for the intended audience. The admin shell now reuses its already-authorised
person ID instead of re-reading the Better Auth session, the home redirect uses
the authorised event result instead of repeating authentication and membership
queries, and the command-centre baseline cursor is captured in its existing
event query. Content-hashed `/assets/*` responses use a one-year immutable cache
policy; unversioned assets retain revalidation.

The post-cutover health probe returned HTTP 200 from source revision `5e46b8f`,
and Cloudflare reports the 2,224,128-byte database in WNAM with no pending
migrations. These are topology and correctness checks, not representative US
West percentile evidence. Smart Placement adapts from traffic, so field RUM and
an authenticated US West admin journey remain the acceptance measurements.

The optimization release (`0380504`, Worker version
`9a4ea3a2-5986-4675-a9ce-c1ffb7b2042b`) was then probed through three
independent California Globalping nodes. All public-programme requests returned
HTTP 200 and ran locally in SJC/LAX. Retained Cloudflare invocation logs report
252 ms, 276 ms and 617 ms Worker wall time; the first two completed end-to-end
in 308 ms and 434 ms, while the third encountered a 2,320 ms edge outlier despite
617 ms of Worker wall time. A California static-asset control completed in 71 ms,
and the deployed hashed asset returned
`Cache-Control: public, max-age=31536000, immutable`. This small sample proves
the corrected locality and cache contract, but its variance is exactly why it
is not presented as a production percentile.

## Interpretation and external acceptance

All values here are local lab evidence, not production percentile claims. The public-filter measurement is a browser feedback proxy, not field INP. Event freshness uses the authoritative D1 commit timestamp, whose one-second resolution makes the local delta conservative but coarse. The single autosave sample proves a bounded real feedback path; it is not a durability claim for adverse networks.

A deployed environment must still collect representative-traffic p75 LCP/CLS/INP, production-like D1 and Durable Object latency across intended geographies and load, schedule drag frame pacing on supported desktop devices, Queue acknowledgement latency, transient-disconnect autosave/recovery behavior and provider-excluded mutation timings. Record those results in `docs/IMPLEMENTATION_STATUS.md` rather than treating this local report as deployed acceptance.
