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

Planned:

- [ ] benchmark-based variant parameter tuning
- [ ] richer lineage evidence using repository history
- [ ] origin inference with explicit confidence/evidence rules

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
  --output benchmark-report.json
```

The harness deterministically samples real Skills and measures index size, in-process trace latency, exact and same-instruction hit rates, and Recall@1/3/10 for controlled light and medium mutations. It does not modify or download the source dataset, and it is not run by CI. Use `--keep-temp` only when fixture inspection is needed.

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
