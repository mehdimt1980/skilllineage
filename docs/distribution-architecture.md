# Phase 14E / PR #18 — Synthetic-only distribution architecture

**Status:** Prototype for local demonstration only. **Real GitSkills-derived indexes remain blocked from public redistribution.**

This step designs and exercises a strict distribution contract **without** enabling network access in the published SkillLineage v1.0.0 runtime. The only accepted input is the repository's known *synthetic onboarding fixture declaration*, not a real GitSkills source. The check is a development guard, **not cryptographic proof of synthetic provenance**; do not relabel real data as synthetic or use the tool to host it.

## Why a separate distribution contract?

The existing schema-0.5 reader uses an index directory with compressed shards under \`exact/\`, \`instructions/\`, \`variants/\` and \`history/\`. It should not silently download content or send the query fingerprint to a remote endpoint. Phase 14D identified 15 TypeScript interfaces / 66 fields across 8 namespaces, including direct repository/path identifiers and content-derived similarity sketches. The [data audit](index-redistribution-audit.md) **did not clear real index redistribution**.

The new prototype is a **source-repository tool**, not shipped in the immutable npm v1.0.0 tarball; no CLI flags or runtime interfaces are modified.

## Format: \`skilllineage-synthetic-distribution-v1\`

A generated distribution manifest has:

- \`format\`: \`skilllineage-synthetic-distribution-v1\`
- \`indexSchemaVersion\`: \`0.5\`
- \`snapshotId\`: \`synthetic-v1\`
- \`syntheticOnly\`: \`true\`
- \`fileCount\` and lexicographically ordered \`files\`
- Every file entry: a fixed-schema **relative path**, exact \`sizeBytes\`, lowercase **SHA-256**

The manifest includes the index's own \`manifest.json\` plus the fixed and any sparse schema-0.5 shards. Invalid routes, duplicates, unsupported snapshot IDs and impossible sizes are rejected. Generation creates a **new sidecar manifest outside** the index directory and refuses to overwrite an existing one.

The consumer must obtain the distribution manifest's **SHA-256 digest from a trusted independent channel**, then provide that digest to the resolver. This pins exactly one set of bytes. A SHA-256 pin is not a publisher signature, does not authenticate the origin of the pin, and says nothing about licensing.

## Run the synthetic demo locally

Prerequisites: Node.js 22+, a source checkout of SkillLineage, and no GitSkills dataset.

From the repository root:

\`\`\`sh
node tools/create-demo-fixture.mjs .skilllineage-demo
node tools/distribution-prototype.mjs prepare .skilllineage-demo/index ./synthetic-distribution.json
node tools/test-distribution-prototype.mjs
\`\`\`

The first command creates the synthetic schema-0.5 onboarding index. The second prints the **manifest SHA-256 pin**; preserve it outside an untrusted transfer channel. The third command runs a complete loopback HTTP simulation and removes its temporary files. It does not contact GitSkills or any external server.

The manual local-only \`fetch\` interface, when an operator already runs a trusted *loopback-only* shard server with the generated test fixture at its root, is:

\`\`\`sh
node tools/distribution-prototype.mjs fetch ./synthetic-distribution.json <trusted-manifest-sha256> http://127.0.0.1:PORT/ exact/00.json.gz ./existing-cache-directory --allow-loopback-network
\`\`\`

\`<...>\` denotes placeholders; the cache directory must already exist. **This repository does not start a permanent server or expose a public endpoint.** For a ready-to-run local server/client test, use \`node tools/test-distribution-prototype.mjs\` instead.

## Behavior and threat model

1. **No networking by default.** \`fetch\` requires explicit \`--allow-loopback-network\`. URLs are restricted to the roots of IPv4/IPv6 loopback literals; no DNS names (including \`localhost\`), arbitrary hosts, credentials, query strings, fragments, redirects, TLS termination assumptions or relative base paths.
2. **Selective requests.** The consumer requests **only one explicitly named shard** listed in the pinned manifest; cache hits avoid all HTTP requests. This prototype does not speculate or prefetch adjacent shards.
3. **Byte verification before caching.** The resolver limits shard sizes (64 MiB each), verifies exact size and SHA-256, and only then stores the verified bytes under \`cache/synthetic-v1/<route>\`. It refuses unsafe shard paths, cache symlinks and corrupted existing entries. Writes use exclusive temporary files and no-overwrite installation.
4. **Cache invalidation via snapshot namespace.** Cache entries are bound to \`snapshotId\` and file digests. Reusing \`synthetic-v1\` for changed data is not supported; immutable snapshot IDs and retention policy are required in any future production design.
5. **Privacy limitations.** Even a shard URL/path communicates what a user queried to the HTTP server. An actual internet resolver would need explicit opt-in, privacy review, minimization and operator-controlled retention.
6. **Authenticity limitations.** A pinned manifest verifies consistency of indexed bytes. It does **not** provide signatures, certificate pinning, revocation, takedown propagation or rights clearance. HTTP is allowed here only over an intentionally local loopback test.
7. **Not a transparent runtime resolver.** Partially hydrated caches are **not** a complete index. Do not pass the incomplete cache directory to the current \`trace --index\` and infer that \`none\` means global absence. Full reader/resolver integration requires a separate API contract and complete/error semantics.

## Verification

The cross-platform synthetic test checks: deterministic manifest generation, refusal to overwrite or relocate inside index, correct SHA pin, selected shard download, **zero HTTP GET on cache hit**, request-count isolation, invalid paths, disallowed origins, explicit network consent, missing entries, cache corruption, same-size remote tampering, redirect rejection, untrusted manifest entries and symlink protection where the OS allows symlink creation.

CI runs this test on Ubuntu Node 22/24 and Windows Node 24. The test creates only temporary **synthetic** files; it is not a legal audit or a live dataset benchmark.

## Go / No-Go

| Gate | Status |
| --- | --- |
| Static distribution manifest contract + integrity pinning | Prototype implemented |
| Selective shard retrieval + verified offline cache | Loopback-only proof of concept |
| Cross-platform CI on synthetic fixtures | Required before merge |
| Remote TLS transport, signed provenance, update/revocation semantics | Not implemented |
| Privacy/rights/takedown audit for actual GitSkills-derived index | **Blocked / unresolved** |
| Hosting, publishing or making a real derived index downloadable | **NO-GO** |

**Phase 14F follow-up:** See [synthetic distribution profile and decision gates](distribution-profile-decision.md). The profiling tool measures selected shard traffic and cache hits without integrating a network resolver into the production reader.

**Historical roadmap (completed in PR #19):** Measure the synthetic resolver's shard traffic, cache hits/misses, and bounded scale behavior; record adapter completeness requirements and Go/No-Go findings. Do not deploy a public server unless the independent redistribution review is complete.
