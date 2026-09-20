# SkillLineage

[![CI](https://github.com/mehdimt1980/skilllineage/actions/workflows/ci.yml/badge.svg)](https://github.com/mehdimt1980/skilllineage/actions/workflows/ci.yml)

**Trace the copies, variants, and lineage evidence of AI Agent Skills.**

**English** | [Deutsch](README.de.md)

SkillLineage is an experimental open-source CLI for identifying how `SKILL.md` files relate to one another across the growing Agent Skills ecosystem.

It uses deterministic fingerprints and normalized instruction matching to answer questions such as:

- Is this Skill an exact copy of another one?
- Does it contain the same instructions with different metadata or line endings?
- How does one local Skill differ from another?
- Where else does the same Skill content occur in a GitSkills-derived index?

> SkillLineage reports evidence, not historical certainty. It does **not** currently claim which repository is the original source of a Skill.

## Current capabilities

### Fingerprint a Skill

```bash
skilllineage fingerprint ./my-skill
```

Produces deterministic fingerprints for:

- raw `SKILL.md` bytes
- Git blob SHA-1
- normalized instruction body
- complete Skill bundle
- per-file inventory

### Compare two Skills

```bash
skilllineage compare ./skill-a ./skill-b
```

Classifies the relationship as one of:

- `identical_bundle`
- `same_skill_md`
- `same_instructions`
- `variant`
- `different`

Local variant comparison uses deterministic 5-token shingle Jaccard similarity.

### Trace a Skill against an index

```bash
skilllineage trace ./my-skill --index ./gitskills-index
```

Current trace precedence:

```text
exact raw content
    ↓
same normalized instructions
    ↓
high-similarity variant candidates
    ↓
none
```

The index is derived from GitSkills metadata and is intentionally separated from the CLI.

## Why SkillLineage?

Agent Skills are increasingly copied, adapted, renamed, bundled, and redistributed across repositories and agent ecosystems. Raw file identity alone is not enough: metadata can change while instructions remain identical, and supporting files can drift while the root `SKILL.md` stays unchanged.

SkillLineage creates a deterministic evidence layer for studying that evolution.

The long-term goal is to make Skill provenance easier to inspect without depending on an LLM, a vector database, or opaque similarity scoring.

## Design principles

- **Deterministic first** — identical inputs produce identical outputs.
- **Zero runtime dependencies** — core functionality uses the Node.js standard library.
- **No Skill execution** — analyzed Skill files are never executed.
- **Evidence over claims** — similarity is not presented as proof of copying or authorship.
- **Local-first analysis** — fingerprinting and comparison work entirely on local files.
- **Index-friendly** — global matching uses compact derived indexes instead of shipping the full source dataset.

## Project status

SkillLineage is currently **early-stage / experimental**.

Implemented:

- [x] deterministic Skill fingerprinting
- [x] Git-compatible blob hashing
- [x] bundle hashing and file inventory
- [x] local Skill comparison
- [x] normalized-instruction matching
- [x] compact sharded exact-match index
- [x] GitSkills-derived index builder
- [x] exact global trace
- [x] same-instructions global trace
- [x] approximate global variant candidate retrieval
- [x] GitHub Actions CI on Node.js 22 and 24
- [x] manual real-GitSkills benchmark harness
- [x] full-scale retrieval profiling
- [x] schema-0.3 variant-sketch micro-sharding
- [x] schema-0.4 precomputed variant-enrichment summaries
- [x] schema-0.5 dataset-observed historical evidence summaries
- [x] trace schema 0.2 user-facing observed historical evidence
- [x] trace schema 0.3 pairwise temporal observation evidence
- [x] trace schema 0.4 evidence graph projection

Planned:

- [ ] benchmark-based variant parameter tuning
- [ ] origin inference only if future evidence rules can support it explicitly

## Development

Requirements:

- Node.js 22+
- npm
- Python 3.13 for the offline GitSkills index builder and benchmark harness

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Run the built CLI:

```bash
node dist/cli/main.js --help
```

## Architecture

```text
src/
  cli/          command dispatch and serialization
  fingerprint/  deterministic Skill fingerprints
  compare/      local relationship and similarity analysis
  index/        static index readers and types
  trace/        global trace engine

tools/
  build-gitskills-index.py
  benchmark-gitskills.py
  run-trace-benchmark.mjs
```

The analysis engines are intentionally kept independent from CLI presentation so they can later be reused from CI, GitHub Actions, or other applications.

## Index schema 0.4

Schema 0.4 retains the schema-0.3 four-hex micro-shard layout for variant sketches and adds sparse precomputed enrichment summaries for normalized instruction hashes.

Variant sketches remain routed by the first four hex characters of the `variantId`:

```text
variants/sketches/a1/b2.json.gz
```

Variant enrichment summaries are routed independently by the first four hex characters of the full normalized-instruction SHA-256:

```text
variants/enrichment/a1/b2.json.gz
```

Only non-empty sketch and enrichment micro-shards are written. Enrichment summaries contain only the static fields needed for final variant presentation: raw variant count, deduplicated copy count, and up to three deterministically ordered repository/path examples. They do not contain Skill source text or normalized instruction text.

At trace time, variant candidates no longer reconstruct these summaries by reading instruction shards and multiple exact shards. Final candidates read the required enrichment micro-shards directly, with one physical read per unique enrichment route. Missing or malformed required enrichment data is treated as an inconsistent index and requires a rebuild.

The matching algorithm is unchanged: normalization, 5-token shingles, bottom-32 sketching, anchor generation, estimated similarity, thresholds, caps, ranking, and trace precedence are unchanged. Schema 0.4 is an index/runtime I/O optimization; it does not introduce historical origin inference or change similarity semantics.

Schema-0.3 and older indexes are not compatible with the schema-0.4 reader.

## Index schema 0.5: observed history foundation

Schema 0.5 adds sparse `history/exact/aa/bb.json.gz` and `history/instructions/aa/bb.json.gz` micro-shards, routed by the first four hex characters of the lowercase Git blob SHA-1 and full normalized-instructions SHA-256 respectively. Summaries count distinct repository/path locations, fetched history, usable timestamps, chronology anomalies, and conflicting duplicate locations. They record deterministic earliest and latest **dataset observations** in UTC and classify indexed-location coverage as `none`, `partial`, or `complete`.

These timestamps do not establish origin, authorship, or copying direction. Historical coverage in GitSkills is incomplete. Schema-0.4 indexes must be rebuilt for the schema-0.5 reader; the matching and ranking algorithms remain unchanged.

Normal `trace` output exposes schema-0.5 dataset-observed history, introduced in public trace schema 0.2. Exact matches use the matched raw Git blob's history. Same-instructions matches use the normalized-instruction group's history. Each final variant candidate carries its own instruction-group history. A missing sparse record reports `not_available` with `no_stored_history`; an empty normalized instruction body reports `empty_normalized_instructions` for instruction-level history. Exact raw-content history remains available for an empty instruction body.

`earliestObserved` is the earliest usable observation among indexed locations represented by the stored evidence, **not** an origin repository. Coverage `none`, `partial`, and `complete` counts usable observations among distinct indexed repository/path locations in that history group. `complete` means all those indexed locations have usable history; it does not mean GitSkills has complete historical coverage globally. `origin.status` remains `not_inferred`, and dates never affect matching or ranking.

Trace schema 0.3 adds `temporalEvidence` only to `variant_candidates` results. It compares each pair of final candidates using their already-loaded `earliestObserved.firstCommitAt` timestamps. Relations follow candidate ranking order and report which instruction group was first observed in the indexed dataset, or that both have the same first-observation time. Missing usable history makes a pair non-comparable; the result reports comparable and non-comparable pair counts. Partial coverage still permits a comparison, but leaves the historical picture incomplete. Temporal ordering does not establish which Skill existed first outside the dataset, which repository is a source, or whether one candidate was copied from another. It does not change ranking or cause additional history reads.

Trace schema 0.4 adds `evidenceGraph` to variant-candidate results. It is a serialization of observed evidence relationships, not a reconstructed historical lineage graph. One query node connects to each final candidate through an approximate query-similarity edge, copied from that candidate's existing score and shared-anchor count. Temporal-observation edges copy the already-reported first-observation relations and coverage states in candidate order. No candidate-to-candidate textual similarity is computed. Neither edge type establishes copying, ancestry, derivation, or origin. Graph projection leaves ranking, temporal evidence, and shard I/O unchanged.

## Continuous Integration

GitHub Actions runs linting, type checking, synthetic tests, and the build on Ubuntu with Node.js 22 and 24 plus Python 3.13. A separate Windows job runs tests and the build with Node.js 24 and Python 3.13 to catch filesystem and path regressions. CI uses read-only repository permissions and never downloads GitSkills or runs real-data benchmarks.

## Benchmarking on GitSkills

The real-data benchmark is manual. It requires a local GitSkills SQLite database, an already-generated SkillLineage index, and a compiled `dist/` tree:

```bash
npm run build
python tools/benchmark-gitskills.py \
  --db /path/to/gitskills.db \
  --index /path/to/skilllineage-index \
  --samples 100 \
  --seed 42 \
  --output benchmark-report.json \
  --details-output benchmark-details.json
```

The harness deterministically samples real Skills and measures index size, in-process trace latency, exact and same-instruction hit rates, and Recall@1/3/10 for controlled light and medium mutations. It does not modify or download the source dataset, and it is not run by CI. Use `--keep-temp` only when fixture inspection is needed.

Benchmark schema 0.2 also profiles the real retrieval pipeline: shard I/O, compressed and decompressed bytes, stage timings, candidate progression, hot-anchor omission evidence, deterministic slow-query summaries, and separate `variant_enrichment`, `history_exact`, and `history_instructions` I/O. Index-size metrics include recursive variant enrichment and history namespaces. This diagnostic profiling does not alter matching semantics. Timings depend strongly on storage, operating system, and cache state; benchmark output never includes Skill source text.

Variant retrieval is approximate. The benchmark reports exact normalized 5-token-shingle Jaccard similarity separately from sketch-estimated similarity, including recall for mutations with exact similarity at least 0.70. Aggregate diagnostics identify candidate-generation and filtering misses; optional `--details-output` records per-query diagnostics without Skill source text. Rebuild schema-0.4 and older indexes with the current builder before tracing or benchmarking; the current reader requires index schema 0.5.

## Historical data audit (Phase 11A)

Phase 11 explores incorporating historical repository metadata into lineage analysis. Before introducing historical claims or index changes, Phase 11A provides an offline, read-only audit tool to evaluate the coverage, consistency, and conflict rates of timestamps in the GitSkills database:

```bash
python tools/audit-gitskills-history.py \
  --db /path/to/agent_skills_release.db \
  --output history-audit.json
```

Key principles of the audit:

- **Observed evidence only** — Timestamps reflect dataset observations, not proof of original authorship, fork origins, or copying direction.
- **Strictly read-only** — The source database is opened in read-only mode and is never mutated.
- **No runtime changes** — No historical inference or temporal ranking is exposed by `skilllineage trace` or index schemas in this phase.

## GitSkills attribution

SkillLineage's offline index builder is designed to derive lineage metadata from the **GitSkills** dataset.

GitSkills metadata and aggregation are distributed under **CC BY 4.0**. Skill source content remains subject to the licenses of the original repositories. SkillLineage therefore keeps derived indexes focused on hashes and lineage metadata rather than redistributing source Skill text.

GitSkills dataset:

- https://huggingface.co/datasets/mvaccargiu/gitskills

## What SkillLineage does not claim

A matching hash or high textual similarity does not, by itself, prove:

- original authorship
- plagiarism
- malicious modification
- a historical fork relationship
- a supply-chain attack

Those conclusions require additional repository and historical evidence.

## License

MIT © 2026 Mehdi Mirabian Tabar
