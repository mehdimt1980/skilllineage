"""Manual real-GitSkills benchmark orchestration for SkillLineage.

Standard library only. This module is importable so its deterministic sampling,
mutation, metric, and workspace behavior can be tested with synthetic fixtures.
"""

from __future__ import annotations

import argparse
import contextlib
import gzip
import hashlib
import importlib.util
import json
import math
import os
import platform
import random
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path


TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
TRACE_WORKER = TOOLS_DIR / "run-trace-benchmark.mjs"
DEFAULT_DIST_ENTRY = REPO_ROOT / "dist" / "index.js"

_builder_spec = importlib.util.spec_from_file_location(
    "_skilllineage_index_builder", TOOLS_DIR / "build-gitskills-index.py"
)
if _builder_spec is None or _builder_spec.loader is None:
    raise RuntimeError("Unable to load the canonical Python normalization implementation")
_builder = importlib.util.module_from_spec(_builder_spec)
_builder_spec.loader.exec_module(_builder)


class BenchmarkError(RuntimeError):
    """A clear user-facing benchmark configuration or execution error."""


SAMPLING_SQL = """
    SELECT
        LOWER(a.file_sha) AS file_sha,
        MIN(a.repo_full_name) AS repo_full_name,
        MIN(a.path) AS path,
        MAX(a.content) AS content
    FROM artifacts a
    WHERE (a.path GLOB '*/SKILL.md' OR a.path = 'SKILL.md')
      AND a.file_sha IS NOT NULL
      AND a.content IS NOT NULL
    GROUP BY LOWER(a.file_sha)
    ORDER BY LOWER(a.file_sha)
"""


def normalized_instruction_sha256(content: str) -> str:
    return _builder.instruction_sha256(content)


def exact_ground_truth_jaccard(original: str, mutated: str) -> float:
    """Mirror TypeScript's normalized, exact 5-token shingle-set Jaccard."""

    def shingles(content):
        tokens = _builder.tokenize_instructions(_builder.normalize_instructions(content))
        if not tokens:
            return set()
        if len(tokens) < 5:
            return {" ".join(tokens)}
        return {" ".join(tokens[i:i + 5]) for i in range(len(tokens) - 4)}

    first, second = shingles(original), shingles(mutated)
    if not first and not second:
        return 1.0
    return len(first & second) / len(first | second)


def sample_representatives(db_path: Path, sample_count: int, seed: int):
    """Reservoir-sample an ordered representative stream using O(sample_count) RAM."""
    if sample_count < 1:
        raise BenchmarkError("--samples must be at least 1")
    rng = random.Random(seed)
    reservoir = []
    uri = db_path.resolve().as_uri() + "?mode=ro"
    usable_seen = 0
    with sqlite3.connect(uri, uri=True) as connection:
        for row in connection.execute(SAMPLING_SQL):
            file_sha, repo_full_name, skill_path, content = row
            if not isinstance(content, str) or not _builder.normalize_instructions(content).strip():
                continue
            usable_seen += 1
            record = {
                "fileSha": file_sha,
                "repoFullName": repo_full_name,
                "path": skill_path,
                "content": content,
            }
            if len(reservoir) < sample_count:
                reservoir.append(record)
            else:
                replacement = rng.randrange(usable_seen)
                if replacement < sample_count:
                    reservoir[replacement] = record
    return sorted(reservoir, key=lambda item: item["fileSha"])


def mutate_same_instructions(content: str) -> str:
    normalized = _builder.normalize_instructions(content)
    raw_marker = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return (
        "---\nname: skilllineage-benchmark-copy\n"
        f"benchmark-source-sha256: {raw_marker}\n---\n" + normalized
    )


def mutate_light(content: str) -> str:
    normalized = _builder.normalize_instructions(content).rstrip("\n")
    return normalized + "\n\nBenchmark light mutation.\n"


def mutate_medium(content: str) -> str:
    normalized = _builder.normalize_instructions(content).rstrip("\n")
    addition = (
        "## Benchmark workflow extension\n\n"
        "1. Review the requested inputs before starting.\n"
        "2. Validate intermediate output deterministically.\n"
        "3. Record any operational limitation in the final response.\n\n"
        "This benchmark-only section changes workflow steps, validation rules, "
        "output handling, and operational guidance."
    )
    return normalized + "\n\n" + addition + "\n"


def mutate_none(seed: int, ordinal: int) -> str:
    return (
        "# Synthetic unrelated benchmark case\n\n"
        f"sentinel-{seed}-{ordinal} calibrates orbital spectroscopy, "
        "crystalline acoustics, and marine cartography.\n"
    )


def create_benchmark_cases(samples, workspace: Path, seed: int):
    queries = []
    identifiers = []
    for ordinal, sample in enumerate(samples):
        expected = "sha256:" + normalized_instruction_sha256(sample["content"])
        identifiers.append({
            "fileSha": sample["fileSha"],
            "repoFullName": sample["repoFullName"],
            "path": sample["path"],
            "instructionsSha256": expected,
        })
        contents = {
            "exact": sample["content"],
            "same_instructions": mutate_same_instructions(sample["content"]),
            "variant_light": mutate_light(sample["content"]),
            "variant_medium": mutate_medium(sample["content"]),
            "none": mutate_none(seed, ordinal),
        }
        for category, content in contents.items():
            case_dir = workspace / f"sample-{ordinal:05d}" / category
            case_dir.mkdir(parents=True, exist_ok=True)
            with open(case_dir / "SKILL.md", "w", encoding="utf-8", newline="") as handle:
                handle.write(content)
            queries.append({
                "id": f"{ordinal}:{category}",
                "category": category,
                "skillPath": str(case_dir),
                "expectedInstructionsSha256": expected,
                **({"groundTruthJaccard": exact_ground_truth_jaccard(sample["content"], content)}
                   if category.startswith("variant_") else {}),
            })
    return queries, identifiers


def percentile(values, fraction: float) -> float:
    """Nearest-rank percentile, with ranks starting at one."""
    if not values:
        raise BenchmarkError("Cannot calculate a percentile of an empty sample")
    ordered = sorted(values)
    rank = max(1, math.ceil(fraction * len(ordered)))
    return ordered[rank - 1]


def latency_summary(values):
    if not values:
        return {"count": 0, "mean": None, "p50": None, "p95": None, "max": None, "raw": []}
    return {
        "count": len(values),
        "mean": statistics.fmean(values),
        "p50": percentile(values, 0.50),
        "p95": percentile(values, 0.95),
        "max": max(values),
        "raw": list(values),
    }


def recall_at(results, limit: int) -> float:
    if not results:
        return 0.0
    hits = 0
    for result in results:
        match = result.get("match", {})
        candidates = match.get("candidates", []) if match.get("type") == "variant_candidates" else []
        expected = result["expectedInstructionsSha256"]
        if any(candidate.get("instructionsSha256") == expected for candidate in candidates[:limit]):
            hits += 1
    return hits / len(results)


def match_type_counts(results):
    counts = {}
    for result in results:
        match_type = result.get("match", {}).get("type", "missing")
        counts[match_type] = counts.get(match_type, 0) + 1
    return dict(sorted(counts.items()))


def category_size(path: Path):
    files = [item for item in path.rglob("*") if item.is_file()] if path.is_dir() else []
    sizes = [item.stat().st_size for item in files]
    shard_sizes = []
    for item, size in zip(files, sizes):
        if item.suffix == ".gz":
            with gzip.open(item, "rt", encoding="utf-8") as handle:
                if not json.load(handle):
                    continue
        shard_sizes.append(size)
    mean_size = statistics.fmean(shard_sizes) if shard_sizes else None
    return {
        "bytes": sum(sizes),
        "fileCount": len(files),
        "nonEmptyFileCount": len(shard_sizes),
        "smallestNonEmptyShardBytes": min(shard_sizes, default=None),
        "meanShardBytes": mean_size,
        "p50ShardBytes": percentile(shard_sizes, 0.50) if shard_sizes else None,
        "p95ShardBytes": percentile(shard_sizes, 0.95) if shard_sizes else None,
        "largestShardBytes": max(sizes, default=0),
        "largestToMeanRatio": max(shard_sizes) / mean_size if mean_size else None,
    }


def similarity_summary(values):
    if not values:
        return {"count": 0, "min": None, "mean": None, "p50": None, "p95": None, "max": None}
    return {
        "count": len(values), "min": min(values), "mean": statistics.fmean(values),
        "p50": percentile(values, 0.50), "p95": percentile(values, 0.95), "max": max(values),
    }


def miss_reason(diagnostic):
    if diagnostic["finalRank"] is not None:
        return None
    if diagnostic["expectedSharedAnchorPostings"] < 2:
        return "insufficient_shared_anchors"
    if not diagnostic["preScoreEligible"]:
        return "pre_score_truncated" if diagnostic["candidateGenerationTruncated"] else "unexpected_missing"
    if not diagnostic["passesEstimatedSimilarityThreshold"]:
        return "below_estimated_similarity"
    if diagnostic["estimatedSketchSimilarity"] is not None:
        return "outside_final_top10"
    return "unexpected_missing"


def variant_quality(results):
    eligible = [item for item in results if item["groundTruthJaccard"] >= 0.70]

    def recalls(items):
        return {"count": len(items), **{f"recallAt{rank}": recall_at(items, rank) for rank in (1, 3, 10)}}

    reasons = {}
    ranks = {"rank1Count": 0, "rank2to3Count": 0, "rank4to10Count": 0, "missingCount": 0}
    for item in results:
        diagnostic = item["diagnostic"]
        rank = diagnostic["finalRank"]
        if rank is None:
            ranks["missingCount"] += 1
            reason = miss_reason(diagnostic)
            reasons[reason] = reasons.get(reason, 0) + 1
        elif rank == 1:
            ranks["rank1Count"] += 1
        elif rank <= 3:
            ranks["rank2to3Count"] += 1
        else:
            ranks["rank4to10Count"] += 1
    return {
        **{f"recallAt{rank}": recall_at(results, rank) for rank in (1, 3, 10)},
        "all": recalls(results), "groundTruthAtLeast070": recalls(eligible),
        "groundTruthJaccard": similarity_summary([item["groundTruthJaccard"] for item in results]),
        "missReasons": dict(sorted(reasons.items())), "successfulExpectedRanks": ranks,
    }


def details_report(results, identifiers):
    sample_by_ordinal = {str(i): identifier for i, identifier in enumerate(identifiers)}
    details = []
    for item in results:
        if not item["category"].startswith("variant_"):
            continue
        sample = sample_by_ordinal[item["id"].split(":", 1)[0]]
        details.append({
            "id": item["id"], "category": item["category"],
            "fileSha": sample["fileSha"], "repoFullName": sample["repoFullName"],
            "path": sample["path"],
            "expectedInstructionsSha256": item["expectedInstructionsSha256"],
            "groundTruthJaccard": item["groundTruthJaccard"],
            **item["diagnostic"], "profiling": item.get("profiling", {}), "missReason": miss_reason(item["diagnostic"]),
        })
    return {"schemaVersion": "0.2", "queries": details}


def _optional_diagnostic(item):
    diagnostic = item.get("diagnostic")
    return diagnostic if isinstance(diagnostic, dict) else {}


def profiling_summary(results):
    stages = {}
    for item in results:
        for name, value in item.get("profiling", {}).get("stages", {}).items():
            stages.setdefault(name, []).append(value)
    reads = [event for item in results for event in item.get("profiling", {}).get("shardReads", [])]
    io = {}
    for kind in ("variant_anchor", "variant_sketch", "variant_enrichment", "instructions", "exact", "history_exact", "history_instructions"):
        selected = [event for event in reads if event["shardKind"] == kind]
        io[kind] = {
            "shardReads": len(selected),
            "compressedBytes": sum(event["compressedBytes"] for event in selected),
            "decompressedBytes": sum(event["decompressedBytes"] for event in selected),
        }
    counts = {}
    for item in results:
        for name, value in item.get("profiling", {}).get("counts", {}).items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                counts.setdefault(name, []).append(value)
    hot = [_optional_diagnostic(item).get("omittedSharedAnchorCount", 0) for item in results]
    return {
        "traceStagesMs": {name: latency_summary(values) for name, values in sorted(stages.items())},
        "candidateGeneration": {name: latency_summary(values) for name, values in sorted(counts.items())},
        "io": io,
        "hotAnchors": {
            "queriesWithOmittedSharedAnchors": sum(value > 0 for value in hot),
            "meanOmittedSharedAnchors": statistics.fmean(hot) if hot else 0,
            "maxOmittedSharedAnchors": max(hot, default=0),
            "eligibleMissesWithOmittedSharedAnchors": sum(
                item.get("groundTruthJaccard", 0) >= .70
                and _optional_diagnostic(item).get("finalRank") is None
                and _optional_diagnostic(item).get("omittedSharedAnchorCount", 0) > 0
                for item in results
            ),
            "eligibleHitsWithOmittedSharedAnchors": sum(
                item.get("groundTruthJaccard", 0) >= .70
                and _optional_diagnostic(item).get("finalRank") is not None
                and _optional_diagnostic(item).get("omittedSharedAnchorCount", 0) > 0
                for item in results
            ),
        },
    }


def slow_queries(results):
    rows = sorted(results, key=lambda item: (-item["durationMs"], item["id"]))[:10]
    return [
        {
            "id": item["id"],
            "durationMs": item["durationMs"],
            "groundTruthJaccard": item.get("groundTruthJaccard"),
            "finalRank": _optional_diagnostic(item).get("finalRank"),
            "missReason": miss_reason(item["diagnostic"]) if item.get("diagnostic") else None,
            "counts": item.get("profiling", {}).get("counts", {}),
            "stages": item.get("profiling", {}).get("stages", {}),
            "shardReads": len(item.get("profiling", {}).get("shardReads", [])),
            "compressedBytes": sum(
                event["compressedBytes"] for event in item.get("profiling", {}).get("shardReads", [])
            ),
            "decompressedBytes": sum(
                event["decompressedBytes"] for event in item.get("profiling", {}).get("shardReads", [])
            ),
            "omittedSharedAnchorCount": _optional_diagnostic(item).get("omittedSharedAnchorCount"),
        }
        for item in rows
    ]


def index_size_metrics(index_dir: Path):
    manifest_path = index_dir / "manifest.json"
    categories = {
        "manifest": {
            "bytes": manifest_path.stat().st_size,
            "fileCount": 1,
            "largestShardBytes": manifest_path.stat().st_size,
        },
        "exact": category_size(index_dir / "exact"),
        "instructions": category_size(index_dir / "instructions"),
        "variantSketches": category_size(index_dir / "variants" / "sketches"),
        "variantAnchors": category_size(index_dir / "variants" / "anchors"),
        "variantEnrichment": category_size(index_dir / "variants" / "enrichment"),
        "historyExact": category_size(index_dir / "history" / "exact"),
        "historyInstructions": category_size(index_dir / "history" / "instructions"),
    }
    all_files = [item for item in index_dir.rglob("*") if item.is_file()]
    return {
        "totalBytes": sum(item.stat().st_size for item in all_files),
        "manifestBytes": manifest_path.stat().st_size,
        "categories": categories,
    }


@contextlib.contextmanager
def temporary_workspace(keep: bool = False):
    workspace = Path(tempfile.mkdtemp(prefix="skilllineage-benchmark-"))
    try:
        yield workspace
    finally:
        if not keep:
            shutil.rmtree(workspace, ignore_errors=True)


def validate_inputs(db_path: Path, index_dir: Path, dist_entry: Path = DEFAULT_DIST_ENTRY):
    if not db_path.is_file():
        raise BenchmarkError(f"GitSkills database not found: {db_path}")
    if not index_dir.is_dir() or not (index_dir / "manifest.json").is_file():
        raise BenchmarkError(f"SkillLineage index not found or incomplete: {index_dir}")
    if not dist_entry.is_file():
        raise BenchmarkError(
            f"Compiled SkillLineage build not found: {dist_entry}. Run 'npm run build' first."
        )


def run_trace_worker(node: str, payload_path: Path):
    completed = subprocess.run(
        [node, str(TRACE_WORKER), str(payload_path)],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise BenchmarkError(f"Trace benchmark worker failed: {detail}")
    return json.loads(completed.stdout)


def build_report(
    db_path: Path,
    index_dir: Path,
    samples: int,
    seed: int,
    keep_temp: bool,
    node: str,
    details_output: Path | None = None,
):
    validate_inputs(db_path, index_dir)
    chosen = sample_representatives(db_path, samples, seed)
    if not chosen:
        raise BenchmarkError("No usable SKILL.md representatives found in the source database")

    with temporary_workspace(keep_temp) as workspace:
        queries, identifiers = create_benchmark_cases(chosen, workspace, seed)
        payload_path = workspace / "trace-input.json"
        payload_path.write_text(
            json.dumps({"indexDir": str(index_dir.resolve()), "queries": queries}),
            encoding="utf-8",
        )
        worker = run_trace_worker(node, payload_path)
        query_by_id = {query["id"]: query for query in queries}
        for item in worker["results"]:
            if item["category"].startswith("variant_"):
                item["groundTruthJaccard"] = query_by_id[item["id"]]["groundTruthJaccard"]
        by_category = {
            name: [item for item in worker["results"] if item["category"] == name]
            for name in ("exact", "same_instructions", "variant_light", "variant_medium", "none")
        }
        exact_hits = sum(item["match"].get("type") == "exact" for item in by_category["exact"])
        same_hits = sum(
            item["match"].get("type") == "same_instructions" for item in by_category["same_instructions"]
        )
        report = {
            "schemaVersion": "0.2",
            "environment": {
                "node": worker["environment"]["node"],
                "python": platform.python_version(),
                "platform": platform.platform(),
                "nodePlatform": worker["environment"]["platform"],
            },
            "dataset": {
                "sourceDbBytes": db_path.stat().st_size,
                "requestedSampleCount": samples,
                "sampleCount": len(chosen),
                "seed": seed,
                "sampleIdentifiers": identifiers,
            },
            "index": index_size_metrics(index_dir),
            "quality": {
                "exactHitRate": exact_hits / len(by_category["exact"]),
                "sameInstructionsHitRate": same_hits / len(by_category["same_instructions"]),
                "none": {
                    "noneRate": (
                        match_type_counts(by_category["none"]).get("none", 0)
                        / len(by_category["none"])
                    ),
                    "observedMatchTypeCounts": match_type_counts(by_category["none"]),
                },
                "variantLight": variant_quality(by_category["variant_light"]),
                "variantMedium": variant_quality(by_category["variant_medium"]),
            },
            "latencyMs": {
                "exact": latency_summary([item["durationMs"] for item in by_category["exact"]]),
                "sameInstructions": latency_summary(
                    [item["durationMs"] for item in by_category["same_instructions"]]
                ),
                "variantLight": latency_summary(
                    [item["durationMs"] for item in by_category["variant_light"]]
                ),
                "variantMedium": latency_summary(
                    [item["durationMs"] for item in by_category["variant_medium"]]
                ),
                "none": latency_summary([item["durationMs"] for item in by_category["none"]]),
            },
            "profiling": {
                "exact": profiling_summary(by_category["exact"]),
                "sameInstructions": profiling_summary(by_category["same_instructions"]),
                "variantLight": profiling_summary(by_category["variant_light"]),
                "variantMedium": profiling_summary(by_category["variant_medium"]),
                "none": profiling_summary(by_category["none"]),
            },
            "slowQueries": {
                "exact": slow_queries(by_category["exact"]),
                "sameInstructions": slow_queries(by_category["same_instructions"]),
                "variantLight": slow_queries(by_category["variant_light"]),
                "variantMedium": slow_queries(by_category["variant_medium"]),
                "none": slow_queries(by_category["none"]),
            },
        }
        if keep_temp:
            report["temporaryWorkspace"] = str(workspace)
        if details_output is not None:
            write_report(details_report(worker["results"], identifiers), details_output)
        return report


def write_report(report, output_path: Path):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Benchmark SkillLineage on a local GitSkills-derived index"
    )
    parser.add_argument("--db", required=True, type=Path, help="Local GitSkills SQLite database")
    parser.add_argument("--index", required=True, type=Path, help="Generated SkillLineage index directory")
    parser.add_argument("--samples", type=int, default=100)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--details-output", type=Path)
    parser.add_argument("--keep-temp", action="store_true")
    parser.add_argument("--node", default=os.environ.get("NODE", "node"))
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    try:
        report = build_report(
            args.db,
            args.index,
            args.samples,
            args.seed,
            args.keep_temp,
            args.node,
            args.details_output,
        )
        write_report(report, args.output)
    except (BenchmarkError, sqlite3.Error, OSError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    print(f"Benchmark report written to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
