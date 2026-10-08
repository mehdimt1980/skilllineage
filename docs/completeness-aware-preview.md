# Phase 14H / PR #21 — Completeness-aware evidence preview

**Scope:** strictly synthetic fixture; source-only prototype. This does **not** change the released \`skilllineage@1.0.0\` behavior, \`traceSkill()\`, public API, index format, matcher ranking or npm release. Real GitSkills-derived indexes remain blocked from online distribution pending the independent rights, privacy and takedown review.

## Why this guard is necessary

The production \`traceSkill\` flow is **exact → normalized instructions → approximate variants → none**. Only seeing a negative in \`exact\` or \`instructions\` shards is insufficient evidence for a \`none\` result. The existing index reader also has sparse optional history routes. A partial index cache is **not** a complete local index and must not be passed to \`trace --index\` as if it were.

This prototype deliberately proves a small subset: whether an exact or same-instructions **positive** is supported by pinned, locally verified synthetic shard bytes. It never returns \`none\` and never constructs or alters a \`TraceReport\`.

## Contract

\`previewSyntheticEvidence(session, { gitBlobSha1, instructionsSha256 })\` consumes only a **genuine, explicitly constructed, SHA-256 pinned** \`createPinnedSyntheticSession\`; the module uses a WeakSet brand to reject caller-created lookalike objects. It validates lowercase 40/64-character hex fingerprints, required fixed routes and gzip JSON structure, and rechecks the digest of a cached shard **after** the session returns a filesystem path to avoid trusting a file that has changed after its first verification. Unpacked shard payload size is capped.

Two possible statuses:

- \`verified_positive\` — \`tier: "exact"\` or \`tier: "same_instructions"\`; the checked route list and **aggregate counts only** are returned. An instruction hit requires resolving and validating every referenced exact shard (and its relevant entries) before claiming a positive. Variants and history are explicitly \`not_evaluated\`; \`origin.status = "not_inferred"\`.
- \`indeterminate\` — missing manifest route, unavailable network, corrupt/pinned-but-malformed shard, inconsistent mapping, tampered cache, invalid input/session, or no result in exact/instructions (the **approximate variant tier has not been evaluated**). A scoped reason and missing route list are supplied; it **never** implies absence in the snapshot.

Even \`verified_positive\` is evidence **only for those tiers**, not an authorship or plagiarism conclusion. No repository or skill text is exposed in this prototype response.

## Run and validate

From repository root (Node 22+, no third-party dataset needed):

\`\`\`sh
node tools/test-synthetic-reader-adapter.mjs
\`\`\`

The test creates its own deterministic synthetic fixture and a temporary loopback HTTP server. Coverage:

- exact positive and matching schema-0.5 synthetic occurrence
- metadata-only change -> same normalized instructions, with required exact lookup
- warm cache -> zero new HTTP requests
- exact/instructions not found -> **indeterminate**, because variants are not evaluated
- missing manifest route -> **indeterminate**, no global none
- cache poisoning and pinned-but-malformed gzip shard -> **indeterminate**
- invalid hash input and fake session object -> rejected without a false positive
- no publisher/network endpoints accessed

CI runs the adapter test on Ubuntu Node 22/24 and Windows Node 24.

## Developer preview boundary

The public v1.0.0 package already supports \`fingerprint\`, \`compare\`, and \`trace\` with a separately supplied local index. See the [developer preview guide](developer-preview.md) for a five-minute synthetic demo and user feedback instructions.

**GO** for distributing v1.0.0 as an accurately described *developer preview* with local-first behavior and clear limits.

**NO-GO** for declaring an incomplete cache to be an index, connecting this adapter to the production CLI without full variant/history semantics, or publishing actual GitSkills-derived shards without completed permissions and privacy review.

After merge, prioritize collecting independent user feedback rather than another speculative implementation phase.
