# PR #20 — Compact pinned manifests & fail-closed synthetic sessions

**Status: source-only synthetic architecture prototype.** No change to public \`skilllineage@1.0.0\`, production \`trace\`, index schema 0.5, or permitted redistribution of GitSkills-derived data.

## Why change the PR #18 resolver?

The [PR #19 synthetic profile](distribution-profile-decision.md) showed a 165,457-byte JSON distribution manifest for a 1,025-file toy index, compared with 704 bytes of the 32 selected compressed shard bodies. The original one-shot function also **re-read and SHA-256-verified the whole manifest on every shard request**. Even with a cache hit, it paid this work again.

This PR introduces two **independent** optimizations:

1. **Transport compression:** deterministic gzip sidecar \`.json.gz\`, authenticated by the SHA-256 of its **compressed bytes**; verify pin *before* decompression. Both compressed size and decompressed size are bounded at 5 MiB. Decompressed JSON must still satisfy the full \`skilllineage-synthetic-distribution-v1\` schema and pathname allowlist. Compression does **not** provide publisher authentication, signing, or permissions.
2. **Per-session immutable snapshot:** \`createPinnedSyntheticSession\` verifies and parses its pinned manifest **once per explicit session**, then retains validated records in a private closure. No process-global cache can silently mix pins or snapshots. All selected shard bodies and cached files continue to be checked for exact size and SHA-256 on each access. A new session must revalidate its own manifest pin; existing sessions use their already-authenticated snapshot even if the on-disk manifest later changes.

Both features are source-only; existing \`prepare\` and one-off \`fetch\` commands stay compatible.

## Reproducible synthetic demo

Node.js 22+, a source checkout, **no GitSkills download**:

\`\`\`sh
node tools/create-demo-fixture.mjs .skilllineage-demo
node tools/distribution-prototype.mjs prepare .skilllineage-demo/index ./synthetic-distribution.json
\`\`\`

Copy the \`sha256\` printed by \`prepare\`, then use it as the second argument:

\`\`\`sh
node tools/distribution-prototype.mjs compact ./synthetic-distribution.json <trusted-raw-manifest-sha256> ./synthetic-distribution.json.gz
node tools/test-compact-manifest-session.mjs
\`\`\`

The \`compact\` command outputs a **different SHA-256**—the digest of the gzip bytes. That compressed digest must be pinned through an independent trusted channel when constructing a session; **do not use the raw JSON digest to verify compressed data**. The generator refuses overwrite. The test starts and stops a loopback-only HTTP server automatically, creates only synthetic index shards, and deletes its temporary files.

Library usage (illustrative, not a production API):

\`\`\`js
import { createPinnedSyntheticSession } from './tools/distribution-prototype.mjs';

const session = await createPinnedSyntheticSession({
  manifestFile: './synthetic-distribution.json.gz',
  pinnedSha256: '<independently-trusted-gzip-SHA256>',
  compression: 'gzip',
  baseUrl: 'http://127.0.0.1:PORT/',
  cacheDir: './existing-local-cache-directory',
  allowLoopbackNetwork: true
});
const resolution = await session.resolve(['exact/00.json.gz', 'instructions/ff.json.gz']);
\`\`\`

No arbitrary hosts (not even \`localhost\` via DNS), credentials, redirects or public servers are accepted. Networking requires explicit opt-in. Cached entries are verified per access, and a corrupted entry fails closed rather than being silently replaced.

## Crucial completeness contract

\`session.resolve(requiredRoutes)\` is a **shard availability check, NOT a query/match result**. It returns:

- \`{status:"complete",snapshotId,verified:[...]}\` **only** when **every requested route** is verified; each result explicitly says \`cache_hit\` or \`downloaded_verified\`.
- \`{status:"indeterminate",snapshotId,reason,missingRoutes:[...]}\` for omitted routes, invalid route requests, checksum/cache corruption, network errors or missing prerequisites.

It **never** returns \`match.type: "none"\`, does not infer absent skills and must not be connected to \`trace\` as a complete index. Even \`status:"complete"\` refers only to the *explicitly requested routes*, not global snapshot completeness. A future reader adapter will need to prove and enumerate all required lookups before interpreting any negative match.

**Session security limitations:** an already-validated snapshot cannot retroactively honor publisher revocation or dataset takedown; this is an opt-in, short-lived local demonstration session with no remotely authenticated signer, governance or revocation mechanism. Even local shard routing may reveal information to its loopback server.

## Observed CI evidence (synthetic only)

From [PR #20 CI run #37771590342](https://github.com/mehdimt1980/skilllineage/actions/runs/37771590342), Ubuntu Node 22, on commit \`fabadbb60a8f9a2397ac0c277e0320fd760647cb\`:

| Observed metric | Result |
| --- | ---: |
| Indexed synthetic files | 769 |
| Uncompressed distribution manifest | **122,448 bytes** |
| Gzip distribution manifest | **2,708 bytes** |
| Compressed / original size ratio | **0.0221** (~97.8% reduction) |
| Selected cold shard requests | **2 HTTP GETs** |
| Warm cached requests | **0 HTTP GETs** |
| Pinned manifest validations per session | **1** |
| Session resolution for missing route | **indeterminate**, never an authoritative no-match |

These are **actual GitHub CI measurements** on a highly repetitive synthetic JSON manifest. They are not a real-data compression guarantee or a CDN price estimate. The test also verified the gzip digest, deterministic output, decompression bound, post-construction manifest modification behavior, and tampered-cache fail-closed handling.

## Verification, metrics and decision

\`node tools/test-compact-manifest-session.mjs\` checks deterministic gzip output, compression reduction, raw and compressed pin mismatch, refusal to overwrite, bounded decompression (zip-bomb guard), opt-in/local origin policy, immutable in-memory snapshot after source tampering, cache integrity and zero-repeat-HTTP behavior, missing-route handling, and absence of authoritative no-match outcomes.

CI runs this on Ubuntu Node 22 and 24, and Windows Node 24; the Node 22 job prints JSON containing actual raw/gzip manifest sizes. **No performance timing or CDN cost promise** is inferred from tiny synthetic shards. Earlier profiling metrics remain in [PR #19](distribution-profile-decision.md).

| Decision | Gate |
| --- | --- |
| Compact manifest + session-scoped pin verification | GO, **synthetic-only** after CI |
| Reader-facing adapter that preserves \`indeterminate\` semantics | Design-only; not merged into runtime |
| Public remote host, automatic downloads, production distribution | NO-GO |
| Actual GitSkills-derived shard publication | **BLOCKED** pending source licensing, PII/privacy and takedown review |

**Next separate step:** evaluate whether manifest chunking and compression offer a net benefit on **locally controlled, rights-cleared** payload distributions; draft a safe, opt-in completeness-aware reader adapter test matrix before changing any production API.
