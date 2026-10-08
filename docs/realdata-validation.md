# Phase 14C — Local Real-Data Validation

## What this phase can and cannot prove

This phase makes the existing GitSkills SQLite → SkillLineage index → \`trace\` benchmark measurable and repeatable using a **local** sample or full-data snapshot. It never executes collected SKILL.md instructions and never publishes a GitSkills index.

**A previously created benchmark JSON is not a new experimental run.** A successful synthetic CI test is not a real-dataset benchmark. A sample-index benchmark measures the official sample, not the full population. Record exactly which snapshot and tool versions were actually used.

## Dataset inputs

Choose one source:

- **Official sample:** [GitSkills sample](https://github.com/giuseppedestefanis/gitskills-sample), approximately 277 MB extracted SQLite, 29,786 file occurrences, 13,000 distinct contents. The sample is a *hash-selected subset*, not necessarily a representative random cross-section of all skills.
- **Full SQLite:** [GitSkills Zenodo record](https://zenodo.org/records/21875637), publisher currently lists a 44.4 GB file.
- The [Hugging Face mirror](https://huggingface.co/datasets/mvaccargiu/gitskills) is Parquet; the current builder expects SQLite.

Dataset content may be subject to repository-level licenses. Do not commit or upload the SQLite, index directory, benchmark raw reports, or sample identifiers. The index is locally built and schema-0.5; a \`match.type: "none"\` is limited to the supplied snapshot.

## Local full workflow

From the SkillLineage source checkout (Node.js >=22, Python 3.13, npm installed):

1. Obtain and extract the publisher's SQLite archive locally; read [index accessibility](index-accessibility.md) for example commands.
2. Preflight and build a schema-0.5 index, ideally in a **fresh** output directory:

\`\`\`bash
python tools/check-gitskills-source.py /data/agent_skills_sample.db
python tools/build-gitskills-index.py /data/agent_skills_sample.db /data/skilllineage-index --source-name GitSkills-sample --source-snapshot July-2026-sample --source-url https://github.com/giuseppedestefanis/gitskills-sample
node tools/index-integrity.mjs generate /data/skilllineage-index /data/index-integrity.json
\`\`\`

3. Run the guarded validation, with all report output **outside** the repository:

\`\`\`bash
node tools/run-realdata-validation.mjs --db /data/agent_skills_sample.db --index /data/skilllineage-index --integrity /data/index-integrity.json --out /data/validation-run-01 --samples 30 --seed 42
\`\`\`

The runner refuses to overwrite an existing output directory and explicitly validates SQLite structure, every indexed file against the supplied SHA-256 sidecar, and the locally compiled runtime before launching the existing benchmark. It writes two files:
- \`raw-benchmark.json\`: **PRIVATE** benchmark evidence, including sampled repository/path identifiers, raw latencies and possibly detailed observations; keep outside Git/GitHub.
- \`aggregate-only.json\`: schema-checked, aggregate-only fields (counts, recall, latency percentiles, bytes and software versions), with no sampled identifiers, paths or per-query records. **Review even aggregates** before redistributing.

If any stage fails, the run is **not complete**. A partially created private output directory may need manual inspection/cleanup.

### Direct aggregation of an existing archived report

\`\`\`bash
node tools/benchmark-summary.mjs /private/benchmark-report.json /private/new-aggregate.json
\`\`\`

This command validates report schema \`0.2\`, finite rates and percentile ordering; strips individual samples, raw latency arrays and outlier/query data; and refuses to overwrite output. **It does not rerun the benchmark**, attest a signed dataset or prove report accuracy.

## Optional pinned-sample run in GitHub Actions

The separate [Manual GitSkills sample validation workflow](../.github/workflows/realdata-sample-validation.yml) is available via Actions → **Real GitSkills sample validation** → **Run workflow**. It is **not run for every PR or commit**. It fetches the publisher's sample at an explicitly pinned commit, extracts it in temporary runner storage, builds and verifies schema 0.5, benchmarks a bounded number of sampled records, and uploads **only** the aggregate output. No raw report, database, index, or SKILL text is uploaded as an artifact. A network failure, publisher archive change, disk shortage or job timeout can still fail the manual run, and the result must be inspected before interpreting it.

Use the linked workflow's exact commit, runner platform, sample count and seed when comparing results. Sample metrics must never be mislabeled as full-population performance.

## Archived evidence — not a Phase 14C rerun

Two **previously supplied** benchmark reports from earlier phases were inspected. Both declare:
- Report schema \`0.2\`, full source SQLite: **44,388,249,600 bytes**.
- Index size: **1,739,647,212 bytes**.
- \`sampleCount = 100\`, \`seed = 42\`; Windows 11; Node \`v24.19.0\`; Python \`3.13.15\`.
- Exact hit rate **100%**, same-instructions hit rate **100%** on their sampled trials, not necessarily across arbitrary skills.
- **Light mutations:** Recall@1 **0.89**, Recall@3 **0.97**, Recall@10 **0.98**.
- **Medium mutations:** Recall@1 **0.80**, Recall@3 **0.88**, Recall@10 **0.89**.

| Archived report | Exact p50 / p95 | Same-instructions p50 / p95 | Light variant p50 / p95 | Medium variant p50 / p95 | No-match p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| Phase 11F | 131 / 171 ms | 257 / 1114 ms | 1118 / 2928 ms | 1095 / 2123 ms | 1095 / 1241 ms |
| Phase 12 | 110 / 134 ms | 210 / 947 ms | 940 / 1974 ms | 932 / 1427 ms | 923 / 1012 ms |

**Archive digests for independently verifying the exact old files (SHA-256):**

- Phase 11F \`benchmark-phase11f-seed42.json\`: \`1892bc51c907d85726b55de5a06d5cb3cae5c4a1e468cd28a7412e2eb664d96d\`
- Phase 12 \`benchmark-phase12-seed42(1).json\`: \`0667a16ee640fe96dd60dfa4733533a1dd9a6c25687693968dc21d6543d9220c\`

These are **archived input measurements**, not a verified repeat execution during Phase 14C. They were not committed because the raw JSON contains sampled repository/path identifiers. Recorded percentiles reflect specific hardware, caches, mutation strategy and benchmark code. The difference between archived runs cannot, by itself, establish a causal speedup; there is no general performance SLA.

## Interpretation and redistribution gate

- Historical \`firstCommitAt\` and \`earliestObserved\` record only indexed dataset observations. They do **not** infer origin, ancestry, plagiarism, licensing status or copying direction; \`origin.status = "not_inferred"\`.
- Derived indexes include repository metadata, paths, hashes, similarity sketches and temporal observations. Their redistribution requires a separate rights, privacy and takedown review. Dataset metadata's CC BY 4.0 terms do not automatically clear embedded or reconstructible Skill content.
- A SHA-256 inventory proves consistency with its sidecar, **not** publisher authenticity. Retain a trusted pinned source commit and independent digest or signed release before distribution.
- **No public index hosting, npm republish or change to retrieval semantics is authorized in Phase 14C.**
