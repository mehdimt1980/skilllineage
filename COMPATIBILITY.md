# SkillLineage Compatibility & Versioning Policy

## Independent Version Spaces

SkillLineage maintains separate, independent version spaces for its npm package release and its internal/public data schemas:

| Version Space | Current Version | Description |
|---|---|---|
| **npm package** | `0.1.0` (candidate for `1.0.0`) | SemVer package release version |
| **Index schema** | `0.5` | Format of static GitSkills-derived lookup shards and manifests |
| **Trace report schema** | `0.5` | Structure of JSON reports returned by `traceSkill` and `skilllineage trace` |
| **Fingerprint report schema** | `0.1` | Structure of JSON reports returned by `fingerprint` and `skilllineage fingerprint` |
| **Compare report schema** | `0.1` | Structure of JSON reports returned by `compareSkills` and `skilllineage compare` |

> Package SemVer and data/report schema versions are independent. A package release may preserve a report schema, and a report schema may change without changing the index schema.

---

## Index Reader Compatibility

The current SkillLineage runtime requires **index schema 0.5**.

- Older index schemas (0.4, 0.3, 0.2, 0.1) are rejected at manifest read time with an explicit `IndexError` directing the consumer to rebuild the index with the current canonical builder.
- The reader does not perform silent migration or cross-schema fallback.

---

## Post-v1.0.0 API Stability Policy

Following the `v1.0.0` release, SkillLineage adheres to strict Semantic Versioning (SemVer 2.0.0):

### Breaking Changes (Require Major Version Bump)
1. **Root Runtime Exports**: Modifying, renaming, or removing exported functions, classes, or constants from the package root (`skilllineage`).
2. **Public TypeScript Types**: Incompatible modifications to publicly exported types and interfaces.
3. **CLI Interface**: Removing or renaming CLI commands, or changing required arguments and options.
4. **Report Schema Invariants**: Removing or changing the semantic meaning of documented JSON report fields in stable report schemas.

### Non-Breaking Changes (Minor / Patch Version Bump)
1. Adding new optional configuration parameters, CLI options, or exported utility functions.
2. Performance improvements and internal caching optimizations.
3. Adding new optional fields to existing report schemas where existing consumers are unaffected.

---

## Guarantees and Non-Guarantees

### What Is Guaranteed:
- **Deterministic Evaluation**: Given identical inputs and index data, the tool produces identical output across all supported operating systems.
- **Zero Runtime Dependencies**: The core package runs on Node.js without third-party production dependencies.
- **Zero Inferred Lineage Claims**: Without explicit ground-truth provenance, reports never claim authorship, origin repository, plagiarism, or copy direction.

### What Is Not Guaranteed:
- **Diagnostic Timing Values**: Timing and latency fields (e.g. `stages.*Ms`, `durationMs`) are diagnostic measurements that vary by hardware, operating system, and cache state; they are not numerical guarantees.
- **Global Historical Completeness**: Historical evidence records observations in the indexed dataset only, not global existence or origin outside the dataset.
- **Approximate Similarity Precision**: Variant candidate similarity is estimated via shingle sketches and is not an exact textual edit distance.
