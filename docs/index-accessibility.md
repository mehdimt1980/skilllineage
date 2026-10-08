# Index access, integrity and redistribution policy (Phase 14B)

SkillLineage `v1.0.0` is an npm-published analysis engine. The npm package does **not** include a GitSkills index, a dataset downloader, or the Python builder. The following tooling is in the **source repository only**. You can build a compatible index from a GitSkills SQLite database that you obtain from its publisher.

## Data sources: choose sample or full

| Source | Intended use | Caveat |
| --- | --- | --- |
| [Official GitSkills sample repository](https://github.com/giuseppedestefanis/gitskills-sample) | Smaller real-data evaluation; extracted SQLite ~277 MB | Sample only; `none` is not a global uniqueness claim |
| [Official full SQLite release on Zenodo](https://zenodo.org/records/21875637) | Full-data local indexing; Zenodo lists ~44.4 GB | Large download, temporary build database and additional disk required |
| [GitSkills Hugging Face dataset](https://huggingface.co/datasets/mvaccargiu/gitskills) | Explore dataset tables in Parquet | Current builder accepts **SQLite**, not Parquet |

GitSkills collected public repository observations in July 2026. Neither its coverage nor its timestamps establish original authorship, copying direction or plagiarism.

## Build a local index from the official sample

Prerequisites: Git, Python 3.13, Node.js 22+, a checkout of this **SkillLineage** repository, and enough disk space for source database, temporary build database and shards.

From the root of your SkillLineage checkout:

```sh
git clone https://github.com/giuseppedestefanis/gitskills-sample.git ./gitskills-sample
python -m zipfile -t ./gitskills-sample/agent_skills_sample.zip
python -m zipfile -e ./gitskills-sample/agent_skills_sample.zip ./gitskills-sample/unpacked
python tools/check-gitskills-source.py ./gitskills-sample/unpacked/agent_skills_sample.db
python tools/build-gitskills-index.py ./gitskills-sample/unpacked/agent_skills_sample.db ./gitskills-sample-index --source-name GitSkills-sample --source-snapshot July-2026-sample --source-url https://github.com/giuseppedestefanis/gitskills-sample
node tools/index-integrity.mjs generate ./gitskills-sample-index ./sample.index-integrity.json
node tools/index-integrity.mjs verify ./gitskills-sample-index ./sample.index-integrity.json
npx --yes skilllineage@1.0.0 trace ./my-skill --index ./gitskills-sample-index
```

These commands are one line each and work from PowerShell or bash. Replace `./my-skill` with a local folder containing `SKILL.md`. If the ZIP extracts to another location, change the `.db` path accordingly. Do not run `trace` until the index build finishes successfully.

The database preflight is **read-only** and checks only required SQLite table/column names. It does not audit license, provenance, coverage or correctness. The builder reads SQLite locally and creates schema-0.5 shards; it does not download, publish or upload source data. The user is responsible for obtaining the published dataset from a trusted source and verifying any provider-published archive checksums. No benchmark of the official sample or full dataset is claimed for this phase.

If the index returns `match.type: "none"`, that only means **not found in the supplied index snapshot**. In particular, the sample does not cover the full dataset.

### Full-data local build

Once you have obtained the publisher's `agent_skills_release.db` from [Zenodo](https://zenodo.org/records/21875637), use the same tools:

```sh
python tools/check-gitskills-source.py /path/to/agent_skills_release.db
python tools/build-gitskills-index.py /path/to/agent_skills_release.db /path/to/private-schema05-index
node tools/index-integrity.mjs generate /path/to/private-schema05-index /path/to/private.index-integrity.json
node tools/index-integrity.mjs verify /path/to/private-schema05-index /path/to/private.index-integrity.json
```

Paths above are placeholders; substitute your actual platform paths. The SQLite file and index should **not** be committed to the SkillLineage repository.

## Preparing a portable index without publishing it

A schema-0.5 index is a directory with `manifest.json`, fixed gzip shards under `exact/`, `instructions/` and `variants/anchors/`, and sparse variant/history microshards. You may transport this directory privately, subject to your rights to handle the data. After moving or extracting it, run `verify` using the *separately stored* integrity sidecar.

`node tools/index-integrity.mjs generate <index-directory> <new-sidecar.json>` creates a deterministic, path-sorted list of every file's **relative path, byte size and streaming SHA-256**. It refuses to overwrite an existing sidecar or put one inside the index directory, and rejects symlinks, special files, unsafe paths, unsupported manifest descriptors and missing required fixed shards.

`node tools/index-integrity.mjs verify <index-directory> <sidecar.json>` checks the entire file set, sizes and SHA-256 hashes; missing, additional and tampered files fail verification. It does not parse or validate every gzip payload as a semantic index: a subsequent real `trace` is also necessary.

**Trust boundary:** the sidecar only establishes consistency with the supplied sidecar. It is **not** a digital signature or a guarantee of publisher authenticity. Attackers who can change both index and sidecar can forge a mutually consistent pair. Pin the expected sidecar digest through a trusted independent channel or establish signed provenance before public distribution.

## Rights and privacy gate — public hosting is NOT authorized

The [GitSkills dataset card](https://huggingface.co/datasets/mvaccargiu/gitskills) makes a critical distinction: aggregated metadata is under **CC BY 4.0**, while included Skill text remains governed by its original repository license. Even a derived index containing hashes, text sketches, paths, repository names and history metadata must **not** automatically be treated as freely redistributable.

Before posting any prebuilt GitSkills index for public download, review:

1. Source snapshot, attribution, actual output fields and redistribution rights—including transformed similarity sketches.
2. Potential leakage via paths, repository metadata, historical records and correlated hashes.
3. Index schema/reader compatibility, deterministic rebuild steps and reproducible benchmark coverage.
4. External checksum signing, authenticated hosting, size limits, safe archive extraction and failure recovery.
5. Removal/takedown procedure and version/update policy.
6. Actual permission to redistribute, with qualified legal review if appropriate.

**Phase 14B does not upload, bundle, download or host a real GitSkills index.** It creates local-access guidance, a read-only source preflight and a distribution-integrity primitive, with no runtime retrieval changes.

## Common errors

- **Not a SQLite database:** extract the ZIP first. The builder cannot read Parquet.
- **Missing table/columns:** source schema mismatch; check the exact sample/full SQLite you downloaded.
- **Missing shard:** rebuild; do not re-label an incompatible schema.
- **Integrity mismatch or unexpected file:** fail closed, restore a trusted sidecar/index or rebuild.
- **Index returns `none`:** no match in that **specific dataset snapshot**, not evidence of global uniqueness.

For first-time users with no data download, see [the synthetic Quickstart](quickstart.md).
