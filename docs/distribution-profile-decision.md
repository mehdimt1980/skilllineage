# PR #19 — Synthetic Distribution Scale Profile & Go/No-Go

**Status: architecture measurement prototype; no public index distribution.**

The work in PR #18 proved a synthetic pinned manifest, selective shard retrieval, verified local cache, and rejection of unsafe requests. This step adds a repeatable, source-only, bounded performance/profile harness and explicit design gates before any real reader integration.

## Measurement method

From a Node 22+ SkillLineage source checkout:

```sh
node tools/test-synthetic-distribution-profile.mjs
node tools/profile-synthetic-distribution.mjs --samples 32 --extra-shards 256
```

The profile creates the **known synthetic** 769-file schema-0.5 onboarding fixture (768 fixed gzip shards + 1 manifest). It optionally adds 0–256 new **empty synthetic gzip JSON sketch shards** in permitted sparse routes, then:

1. Generates a deterministic distribution sidecar, records its size and its trusted SHA-256 pin; verifies that same pinned manifest during every individual request.
2. Chooses a bounded, deterministic spread of unique shard routes from the pinned manifest (1–128 distinct sampled routes).
3. Starts a temporary loopback-only HTTP server bound to **127.0.0.1**, serving only enumerated synthetic paths.
4. Downloads each selected shard exactly once through the existing opt-in resolver, checks byte length and SHA-256 before caching, and records request count, body bytes and latency.
5. Repeats the same requests with a warm cache, independently checks the cached shard integrity, and asserts **zero additional HTTP requests** and **zero additional HTTP response-body bytes**.
6. Tears down the loopback server and all temporary files regardless of outcome.

The standard CI profile uses **1,025 distribution files**, **32 distinct shard routes**, Node 22 on Ubuntu; additional bounded tests run across Ubuntu Node 22/24 and Windows Node 24.

### Metrics and caveats

| Field | Meaning |
| --- | --- |
| `fixture.distributionFileCount` | How many synthetic files are listed in the distribution manifest |
| `fixture.totalIndexedBytes` | Exact total compressed bytes of the synthetic source index files |
| `fixture.selectedShardBytes` | Total compressed payload bytes needed for the selected routes |
| `fixture.distributionManifestBytes` | Uncompressed **sidecar JSON manifest** bytes, which are not included in simulated HTTP traffic |
| `cold.httpRequests` / `cold.httpResponseBodyBytes` | HTTP GET count and response **body only** bytes transmitted for cache misses |
| `warm.httpRequests` / `warm.httpResponseBodyBytes` | Must both equal **zero** after the same shards have been verified in cache |
| `cold/warm.p50Ms`, `cold/warm.p95Ms` | Nearest-rank sampled local loopback operation latencies, not production SLAs |
| `completeness` | Always `SELECTED_SHARDS_ONLY_NOT_A_COMPLETE_INDEX` |

**Interpretation limits:** The fixture is dominated by tiny empty gzip shards, not the real distribution of GitSkills data, and does not reproduce CDN latency, bandwidth charges, TLS, network headers, compression negotiation, contention or real matching workloads. These measurements validate *mechanical correctness and a small synthetic scaling example*, **not** how fast or cheap a hosted GitSkills index would be. The generated manifest itself grows with the file count and is read/re-hashed by the current prototype **for each request**, which may become expensive at much larger scales. No code has been added to the immutable npm v1.0.0 runtime.

### Reproducibility and results

The automated Ubuntu Node 22 CI step prints a JSON report directly in the job log after the synthetic contract tests. A successful CI run is traceable by job URL and commit SHA. Do not compare timings across OS, runner types or changing workloads as though they are directly controlled performance experiments.

At review time, record at least one actual CI run ID and confirmed cold/warm request+byte counts here. Do not substitute guessed timings.

## Why an opt-in reader adapter needs a separate contract

**Partial cache != complete index.** The existing `trace --index` reader assumes a schema-0.5 directory with required fixed shard files. Handing it a partially hydrated directory can make missing evidence look like `none` or an index error, creating a dangerous completeness ambiguity.

For a future adapter, require discriminated outcomes that preserve this distinction:

```ts
type ShardResolution =
  | { status: "verified"; bytes: Uint8Array; sha256: string }
  | { status: "missing_in_manifest"; snapshotId: string }
  | { status: "unavailable"; reason: "network" | "timeout" | "integrity" | "cache_corruption" | "policy" };

type TraceResolution =
  | { status: "complete"; snapshotId: string; report: TraceReport }
  | { status: "indeterminate"; snapshotId: string; missingRoutes: string[]; reason: string };
```

This sketch is a **design proposal, not current public API**. Only a fully established snapshot, and a proven set of all lookups required for a given query, may produce an authoritative negative in that snapshot. Missing, timeouts, partial hydration, checksum mismatch or rejected network permission must never silently become `match.type: "none"`. Any implicit opt-in to remote requests is disallowed.

Additional requirements for a production design: independently authenticated, signed snapshot metadata; retention and revocation policy; per-query disclosure analysis; cost controls, backpressure and bounded downloads; concurrent/atomic cache management; explicit offline mode; reader instrumentation and complete/unknown test fixtures; accessibility and reproducible benchmark evaluation.

## GO / NO-GO gates

| Decision | Position |
| --- | --- |
| Keep current offline `skilllineage@1.0.0` behavior unchanged | **GO** |
| Continue synthetic-only cache/router experiments and adapter API design | **GO**, conditional on CI/integrity correctness |
| Treat a partial cache as a complete GitSkills index | **NO-GO** |
| Turn on network by default or use an arbitrary remote index server | **NO-GO** |
| Host, bundle or download an actual GitSkills-derived index | **NO-GO** until source-specific rights/privacy/takedown/signature review |
| Promise real-network performance or CDN costs based on synthetic localhost metrics | **NO-GO** |

The [Phase 14D audit](index-redistribution-audit.md) still blocks public redistribution: GitSkills metadata aggregation licensing does not automatically grant redistribution rights for all content-derived sketches or source repository identifiers. Neither this synthetic profiling harness nor success in GitHub Actions constitutes legal clearance.

**Recommended next step:** Keep index builds local, solicit explicit clarification from the dataset maintainers (the draft email remains unsent), and, separately, design a fail-closed **synthetic-only** opt-in reader adapter if user-experience evaluation warrants it. Do not deploy public GitSkills-derived shards yet.
