import gzip
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from tools import benchmark_gitskills as benchmark


class SketchMicroshardMetricTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="skilllineage-microshard-metrics-"))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    @staticmethod
    def write_gzip(path: Path, payload: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(gzip.compress(json.dumps(payload).encode("utf-8"), mtime=0))

    def test_category_size_recurses_into_nested_sketch_routes(self):
        sketches = self.root / "variants" / "sketches"
        for route, payload in {
            ("a1", "b2"): {"a1b2": {"instructionsSha256": "f" * 64, "sketch": ["01"]}},
            ("c3", "d4"): {"c3d4": {"instructionsSha256": "e" * 64, "sketch": ["02"]}},
        }.items():
            directory, filename = route
            self.write_gzip(sketches / directory / f"{filename}.json.gz", payload)

        metrics = benchmark.category_size(sketches)
        self.assertEqual(metrics["fileCount"], 2)
        self.assertEqual(metrics["nonEmptyFileCount"], 2)
        self.assertGreater(metrics["bytes"], 0)
        self.assertGreater(metrics["smallestNonEmptyShardBytes"], 0)
        self.assertGreater(metrics["largestShardBytes"], 0)

    def test_index_size_metrics_reports_nested_variant_enrichment(self):
        index = self.root / "index"
        (index / "manifest.json").parent.mkdir(parents=True, exist_ok=True)
        (index / "manifest.json").write_text("{}", encoding="utf-8")
        enrichment = index / "variants" / "enrichment"
        self.write_gzip(
            enrichment / "a1" / "b2.json.gz",
            {
                "a1b2" + "0" * 60: {
                    "rawVariantCount": 2,
                    "copyCount": 3,
                    "examples": [
                        {"repoFullName": "owner/repo", "path": "SKILL.md", "stars": 7}
                    ],
                }
            },
        )
        metrics = benchmark.index_size_metrics(index)
        enrichment_metrics = metrics["categories"]["variantEnrichment"]
        self.assertEqual(enrichment_metrics["fileCount"], 1)
        self.assertEqual(enrichment_metrics["nonEmptyFileCount"], 1)
        self.assertGreater(enrichment_metrics["bytes"], 0)
        self.assertGreater(enrichment_metrics["meanShardBytes"], 0)
        self.assertGreater(enrichment_metrics["p50ShardBytes"], 0)
        self.assertGreater(enrichment_metrics["p95ShardBytes"], 0)

        self.write_gzip(index / "history" / "exact" / "a1" / "b2.json.gz", {"a1b2": {}})
        self.write_gzip(index / "history" / "instructions" / "c3" / "d4.json.gz", {"c3d4": {}})
        history_metrics = benchmark.index_size_metrics(index)["categories"]
        self.assertEqual(history_metrics["historyExact"]["fileCount"], 1)
        self.assertEqual(history_metrics["historyInstructions"]["fileCount"], 1)

    def test_profiling_summary_accounts_for_variant_enrichment_io(self):
        results = [
            {
                "profiling": {
                    "stages": {"variantEnrichmentMs": 12.0},
                    "counts": {"enrichmentSummaryShardCount": 1},
                    "shardReads": [
                        {
                            "shardKind": "variant_enrichment",
                            "compressedBytes": 123,
                            "decompressedBytes": 456,
                        },
                        {"shardKind": "history_exact", "compressedBytes": 11, "decompressedBytes": 22},
                        {"shardKind": "history_instructions", "compressedBytes": 33, "decompressedBytes": 44},
                    ],
                },
                "diagnostic": None,
            }
        ]
        summary = benchmark.profiling_summary(results)
        self.assertEqual(summary["io"]["variant_enrichment"]["shardReads"], 1)
        self.assertEqual(summary["io"]["variant_enrichment"]["compressedBytes"], 123)
        self.assertEqual(summary["io"]["variant_enrichment"]["decompressedBytes"], 456)
        self.assertEqual(summary["io"]["history_exact"]["shardReads"], 1)
        self.assertEqual(summary["io"]["history_instructions"]["compressedBytes"], 33)
        self.assertEqual(
            summary["candidateGeneration"]["enrichmentSummaryShardCount"]["p95"],
            1,
        )


if __name__ == "__main__":
    unittest.main()
