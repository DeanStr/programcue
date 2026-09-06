# Performance measurement runbook

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

## Recorded measurements

The [implementation audit](IMPLEMENTATION_STATUS.md#performance-measurements)
contains the 20 August 2026 baseline and scale results and the earlier production
region-cutover evidence. Those dated samples do not validate the current checkout.
Record new measurements there, with their date, source revision and environment.

## Interpretation and external acceptance

The local harness produces lab evidence, not production percentile claims. The public-filter measurement is a browser feedback proxy, not field INP. Event freshness uses the authoritative D1 commit timestamp, whose one-second resolution makes the local delta conservative but coarse. The single autosave sample proves a bounded real feedback path; it is not a durability claim for adverse networks.

A deployed environment must still collect representative-traffic p75 LCP/CLS/INP, production-like D1 and Durable Object latency across intended geographies and load, schedule drag frame pacing on supported desktop devices, Queue acknowledgement latency, transient-disconnect autosave/recovery behavior and provider-excluded mutation timings. Record those results in [the implementation audit](IMPLEMENTATION_STATUS.md#performance-measurements) rather than treating this local report as deployed acceptance.
