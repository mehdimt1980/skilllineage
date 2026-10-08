# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-08

### Initial Stable Release
- First stable release of SkillLineage (`v1.0.0`).
- Establishes frozen public runtime API and strict NodeNext TypeScript declarations.
- Targeted deterministic, synthetic semantic regression tests spanning all trace match types (`exact`, `same_instructions`, `variant_candidates`, `none`); these do not replace full-dataset benchmark validation.

### Fingerprinting
- Deterministic Skill fingerprinting generating canonical Git blob SHA-1 and normalized-instruction SHA-256 digests.
- File inventory normalization for agent directory structures.

### Comparison
- Pairwise Skill comparison reporting exact identity, same-instruction matches, or approximate shingle-based similarity.
- Frontmatter-agnostic instruction normalization.

### Global Trace
- Multi-tier matching pipeline with deterministic precedence: exact raw Git blob match -> same normalized instructions -> approximate variant candidates -> none.
- Complete machine-readable trace reports under schema 0.5.
- Epistemic invariant maintaining `origin.status = not_inferred` across all match types.

### Approximate Variant Retrieval
- Bottom-32 token shingle sketching (`bottom-k-token-shingles-v1`) with 5-token shingles and SHA-256-96 hashing.
- Two-tier candidate generation and routing with SHA-256 anchor shards and sparse sketch micro-shards.
- Precomputed variant enrichment summaries providing instant candidate metadata without secondary shard scans.

### Historical Evidence
- Read-only historical evidence foundation under index schema 0.5.
- Sparse exact and instruction history micro-shards recording earliest and latest dataset observations in UTC with location-level coverage accounting.

### Temporal Evidence
- Pairwise dataset-observation-order comparisons across final variant candidates.
- Conservative comparability accounting distinguishing comparable from non-comparable candidate pairs based on stored historical evidence.

### Evidence Graph
- Graph serialization projection (`evidenceGraph`) capturing query-to-candidate similarity edges and candidate-to-candidate temporal observation edges.
- Explicit non-directional semantics preventing unauthorized ancestry or lineage claims.

### Evidence Summary
- Deterministic human-readable explanation layer (`evidenceSummary`) projecting existing match facts and explicit epistemic limitations.
- Zero LLM, zero additional I/O, and zero new inference during summary construction.

### CLI / Packaging
- Production packaging hardening with zero runtime dependencies.
- Standardized CLI entrypoint with deterministic stdout JSON streaming and stderr error isolation.
- Full TypeScript declarations and ESM-only export configuration.
