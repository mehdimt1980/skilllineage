# Phase 14D / Step 1 — Index Data and Redistribution Audit

**Status (2026-10-08): TECHNICAL INVENTORY COMPLETE; PUBLIC RELEASE BLOCKED.**

This is a source-code-backed **data exposure and distribution-readiness inventory**, **not** a legal clearance, security penetration test, DPIA, or a scan of the entire real GitSkills dataset. No dataset content, sampled real index, or downloadable derived index is included in this PR.

**Canonical machine-readable field map:** [index-field-inventory.json](index-field-inventory.json). The CI contract test enumerates all exported interfaces from \`src/index/types.ts\`, requires every field to have an explicit qualitative risk label, and checks the eight storage namespaces and known builder emitters. The test does **not** find sensitive values in real-data index entries and does not automatically certify that a field is safe to publish.

## 1. Code-grounded inventory

| Index namespace (schema 0.5) | Fields and structure actually emitted | Exposure/risk considerations |
| --- | --- | --- |
| \`manifest.json\` | Source name/snapshot/license/URL; schema, algorithm descriptors and record counts | Provenance and attribution can be misstated; source-level \`license\` is **not** a per-repository content grant |
| \`exact/??.json.gz\` | Git blob SHA-1 → copyCount, occurrences with \`repoFullName\`, \`path\`, \`locationClass\`, \`stars\`, \`firstCommitAt\`, \`lastCommitAt\`, \`historyFetched\` | Explicit repository/path identifiers, membership lookup, correlation to sensitive filenames and history |
| \`instructions/??.json.gz\` | Normalized-instructions SHA-256 → list of git blob SHA-1 hashes | Linkage across raw content and normalized instructions, dictionary/membership attacks against known text |
| \`variants/anchors/??.json.gz\` | 96-bit shingle hash → variant identifiers | Content-derived term-shingle evidence, membership and correlation; not harmless because plaintext is absent |
| \`variants/sketches/??/??.json.gz\` | Variant ID → \`instructionsSha256\`, array of 96-bit shingle hashes | Potential content inference or linkage, especially when an adversary controls candidate queries |
| \`variants/enrichment/??/??.json.gz\` | Instruction SHA-256 → \`rawVariantCount\`, \`copyCount\`, \`examples\` containing \`repoFullName\`, \`path\`, \`stars\` | Identifiable examples plus group linkage |
| \`history/exact/??/??.json.gz\` | Git blob SHA-1 → counts, coverage, earliest/latest observed repo/path/timestamps | Joined repository-history metadata may reveal sensitive relationships |
| \`history/instructions/??/??.json.gz\` | Instruction SHA-256 → same sparse history-summary structure | Same, plus cross-variant linkage |

**Audited code:** \`tools/build-gitskills-index.py\` (the actual emitter), \`src/index/types.ts\` (consumer data contract), and \`src/index/reader.ts\` (validation/lookup). Specific builder emitters include \`build_exact_index\`, \`_write_variant_sketches\`, \`_write_variant_anchors\`, variant enrichment and \`_write_history\`.

The builder reads \`artifacts.content\` to derive normalized instruction hashes and sketches, but does **not** emit full \`SKILL.md\` plaintext into these declared index entries. **This is not an anonymity or clearance claim**: content-derived fingerprints may be linkable and source identifiers are retained directly. The on-disk index does not automatically include every column in GitSkills (e.g. full author messages and sibling-file text are not part of the declared index). Note that the index's \`source.license\` field describes an aggregate source declaration, not an assessment of each \`repos.license\` or original repository terms.

## 2. Risk treatment and decisions

| Class | Example | Phase 14D decision |
| --- | --- | --- |
| High | \`repoFullName\`, \`path\`, history representative locations | HOLD; risk of identification, cross-reference, contextual and deletion/retraction concerns |
| High | Content-derived sketches / anchor postings | HOLD; evaluate membership, dictionary and reconstruction risks before **any** public distribution |
| Moderate | Raw and normalized content hashes, timestamps, stars, metadata | HOLD; linkage, correlation, metadata accuracy, and potentially mixed-license derivation |
| Low | Schema constants, algorithm names, isolated coarse counts | Candidate for a separately reviewed, aggregate-only informational report; still not preapproved |

\`low\` means **lower direct exposure in isolation**, not safe-to-publish or legal permission. Nested types are conservatively marked high when they can contain high-risk fields.

### No proposed public index yet

Do **not** upload the existing \`exact\`, \`instructions\`, \`variants\`, \`history\` or comprehensive manifest alongside a hosted index, CDN, npm package or GitHub Release.

The only near-term distribution candidate is a **separately authored aggregate-only technical report** that excludes repository IDs, paths, content hashes, sketches, timelines and raw case details. Such reports still require final review of source attribution, claims and destination. The aggregate benchmark report produced in Phase 14C is an example of this *kind* of artifact, not an authorization to publish new material.

If stakeholders later approve a minimized downloadable index design, it would be a **new contract with fresh privacy, licensing, ranking/recall and compatibility tests**, not a silent redaction of schema 0.5. Today's reader requires the current layout; deleting arbitrary fields would break it or change semantics.

## 3. Source terms and outstanding authority

The [GitSkills dataset card](https://huggingface.co/datasets/mvaccargiu/gitskills) distinguishes CC BY 4.0 for *aggregated metadata/collection* from repository-specific licensing of reproduced \`content\`. Its original sample and methodology are described in the [GitSkills sample repository](https://github.com/giuseppedestefanis/gitskills-sample). The dataset's research license **does not, by itself, establish** that SkillLineage can republish derived shingle indexes, paths and repository-history combinations without conditions. The repository authors cannot necessarily grant rights to all third-party source materials.

Questions still requiring authoritative answers:

1. Does the intended reuse of *derived hashes and shingle sketches* fall within the aggregation license, and what explicit attribution/notice is expected? Seek clarification, not merely permission by implication.
2. Does redistribution of enumerated \`repoFullName/path\` occurrences and dated metadata raise data-protection, confidentiality, contractual or takedown issues?
3. How do per-repository licenses and removals/opt-outs propagate into rebuilt index snapshots and caches?
4. Is distributing a limited, **non-reconstructive aggregate-only** report acceptable independently of index hosting?
5. Would an optional client-side/no-network index builder be a preferable first-user route while permission remains unresolved?

External advice may be needed, especially regarding German/EU personal-data processing and original repository licenses. **No legal determination is made here.**

## 4. Draft outreach questions (NOT SENT)

**Subject:** Clarification on derived metadata/sketch redistribution from the GitSkills dataset

Dear GitSkills research team,

We maintain SkillLineage, a deterministic open-source tool that identifies exact and approximate relationships among Agent Skills. We use GitSkills locally to build indexes for empirical matching. These indexes do not store raw SKILL.md files, but do include git blob hashes, normalized-instruction hashes, hashed token-shingle sketches, repository/path occurrences, and sparse historical observation summaries.

Your dataset card distinguishes CC BY 4.0 aggregation/metadata from source repositories' own licenses for file contents. Could you clarify the intended scope of redistribution of these *derived* structures, attribution expectations, and any known restrictions or procedures for takedown/update? We understand the dataset authors may not be able to license underlying third-party content and will review original repositories separately.

We are **not** hosting or releasing a GitSkills-derived index while these questions are open. Thank you for any guidance or relevant policy references.

Best regards,
SkillLineage maintainers

## 5. Exit gates / next step

- [x] Enumerate all 8 on-disk namespaces and the 14 exported type contracts.
- [x] Label all 63 fields with qualitative exposure levels in a machine-readable inventory.
- [x] Add a CI contract-coverage test that fails on unreviewed type or namespace changes.
- [x] Identify privacy/licensing limitations and prepare (but do not send) an inquiry.
- [ ] Obtain documented clarification / independent advice on derived-index redistribution.
- [ ] Review public hosting, opt-out/takedown, source removals and retention rules.
- [ ] Test whether a proposed minimized format retains usable exact/variant matching while protecting content/identifiers.

**Decision: \`GO\` to a synthetic-only distribution architecture prototype (Phase 14E), \`NO-GO\` to hosting real GitSkills-derived indexes.** A subsequent PR must not interpret this document as a grant of redistribution rights.
