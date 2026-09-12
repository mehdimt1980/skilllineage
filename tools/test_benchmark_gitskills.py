import json
import gzip
import hashlib
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from tools import benchmark_gitskills as benchmark


class BenchmarkToolingTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="skilllineage-benchmark-test-"))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def make_db(self, count=20):
        db_path = self.root / "gitskills.db"
        connection = sqlite3.connect(db_path)
        connection.execute("""
            CREATE TABLE artifacts (
                file_sha TEXT, repo_full_name TEXT, path TEXT, content TEXT
            )
        """)
        for index in range(count):
            connection.execute(
                "INSERT INTO artifacts VALUES (?, ?, ?, ?)",
                (
                    f"{index + 1:040x}",
                    f"owner/repo-{index}",
                    f"skills/{index}/SKILL.md",
                    f"# Skill {index}\n\none two three four five six {index}\n",
                ),
            )
        connection.execute(
            "INSERT INTO artifacts VALUES (?, ?, ?, ?)",
            ("f" * 40, "ignored/repo", "skills/lower/skill.md", "ignored"),
        )
        connection.commit()
        connection.close()
        return db_path

    def sample_hashes(self, db_path, seed):
        return [
            record["fileSha"]
            for record in benchmark.sample_representatives(db_path, 5, seed)
        ]

    def test_deterministic_sample_selection(self):
        db_path = self.make_db()
        self.assertEqual(self.sample_hashes(db_path, 42), sorted(self.sample_hashes(db_path, 42)))

    def test_same_seed_gives_same_samples(self):
        db_path = self.make_db()
        self.assertEqual(self.sample_hashes(db_path, 42), self.sample_hashes(db_path, 42))

    def test_different_seed_can_change_samples(self):
        db_path = self.make_db(50)
        self.assertNotEqual(self.sample_hashes(db_path, 1), self.sample_hashes(db_path, 2))

    def test_sampling_does_not_order_by_random(self):
        normalized_sql = " ".join(benchmark.SAMPLING_SQL.upper().split())
        self.assertNotIn("ORDER BY RANDOM", normalized_sql)

    def test_sampling_excludes_empty_instruction_bodies(self):
        db_path = self.make_db(1)
        with sqlite3.connect(db_path) as connection:
            connection.execute(
                "INSERT INTO artifacts VALUES (?, ?, ?, ?)",
                ("e" * 40, "empty/repo", "empty/SKILL.md", "---\nname: empty\n---\n"),
            )
        self.assertNotIn("e" * 40, self.sample_hashes(db_path, 42))

    def test_exact_mutation_preserves_original_content(self):
        content = "# Original\r\n\r\nBody.\r\n"
        sample = {"fileSha": "a" * 40, "repoFullName": "a/b", "path": "SKILL.md", "content": content}
        queries, _ = benchmark.create_benchmark_cases([sample], self.root / "cases", 42)
        exact = next(query for query in queries if query["category"] == "exact")
        with open(Path(exact["skillPath"]) / "SKILL.md", encoding="utf-8", newline="") as handle:
            self.assertEqual(handle.read(), content)

    def test_frontmatter_mutation_preserves_normalized_instructions(self):
        content = "---\nname: original\n---\n# Body\nDo the work.\n"
        mutated = benchmark.mutate_same_instructions(content)
        self.assertNotEqual(content, mutated)
        self.assertEqual(
            benchmark._builder.normalize_instructions(content),
            benchmark._builder.normalize_instructions(mutated),
        )

    def test_light_mutation_changes_instructions_but_remains_related(self):
        content = "# Body\none two three four five six seven eight\n"
        mutated = benchmark.mutate_light(content)
        self.assertNotEqual(
            benchmark.normalized_instruction_sha256(content),
            benchmark.normalized_instruction_sha256(mutated),
        )
        self.assertIn("one two three four five six", mutated)

    def test_medium_mutation_changes_instructions(self):
        content = "# Body\none two three four five six seven eight\n"
        self.assertNotEqual(
            benchmark.normalized_instruction_sha256(content),
            benchmark.normalized_instruction_sha256(benchmark.mutate_medium(content)),
        )

    def test_expected_target_sha_is_original_normalized_hash(self):
        content = "---\nname: x\n---\n# Body\nText.\n"
        sample = {"fileSha": "b" * 40, "repoFullName": "a/b", "path": "SKILL.md", "content": content}
        _, identifiers = benchmark.create_benchmark_cases([sample], self.root / "cases", 7)
        self.assertEqual(
            identifiers[0]["instructionsSha256"],
            "sha256:" + benchmark.normalized_instruction_sha256(content),
        )

    @staticmethod
    def recall_fixture():
        candidates = [
            {"instructionsSha256": "sha256:wrong-1"},
            {"instructionsSha256": "sha256:wrong-2"},
            {"instructionsSha256": "sha256:target"},
        ]
        return [{
            "expectedInstructionsSha256": "sha256:target",
            "match": {"type": "variant_candidates", "candidates": candidates},
        }]

    def test_recall_at_1(self):
        self.assertEqual(benchmark.recall_at(self.recall_fixture(), 1), 0.0)

    def test_recall_at_3(self):
        self.assertEqual(benchmark.recall_at(self.recall_fixture(), 3), 1.0)

    def test_recall_at_10(self):
        self.assertEqual(benchmark.recall_at(self.recall_fixture(), 10), 1.0)

    def test_percentile_uses_nearest_rank(self):
        self.assertEqual(benchmark.percentile([5, 1, 4, 2, 3], 0.50), 3)

    def test_p50_and_p95_for_small_samples(self):
        summary = benchmark.latency_summary([1.0, 2.0, 10.0])
        self.assertEqual(summary["p50"], 2.0)
        self.assertEqual(summary["p95"], 10.0)

    def make_index(self):
        index = self.root / "index"
        for relative in ("exact", "instructions", "variants/sketches", "variants/anchors"):
            (index / relative).mkdir(parents=True, exist_ok=True)
        (index / "manifest.json").write_bytes(b"12345")
        for category in ("exact", "instructions", "variants/sketches", "variants/anchors"):
            (index / category / "00.json.gz").write_bytes(gzip.compress(b'{"key":[]}', mtime=0))
        return index

    def test_index_size_category_accounting(self):
        metrics = benchmark.index_size_metrics(self.make_index())
        self.assertEqual(metrics["manifestBytes"], 5)
        self.assertEqual(metrics["categories"]["manifest"]["fileCount"], 1)
        self.assertEqual(metrics["categories"]["exact"]["fileCount"], 1)
        self.assertEqual(metrics["categories"]["variantAnchors"]["nonEmptyFileCount"], 1)
        self.assertEqual(metrics["totalBytes"], 5 + sum(
            item["bytes"] for name, item in metrics["categories"].items() if name != "manifest"))

    def test_largest_shard_accounting(self):
        index = self.make_index()
        larger = gzip.compress(b'{"key":["longer-value"]}', mtime=0)
        (index / "exact" / "01.json.gz").write_bytes(larger)
        self.assertEqual(benchmark.index_size_metrics(index)["categories"]["exact"]["largestShardBytes"], len(larger))

    def test_anchor_routing_is_deterministic_and_distributed(self):
        anchors = [f"{value:024x}" for value in range(32)]
        prefixes = [benchmark._builder.anchor_shard_prefix(anchor) for anchor in anchors]
        self.assertEqual(prefixes[0], hashlib.sha256(anchors[0].encode()).hexdigest()[:2])
        self.assertEqual(prefixes, [benchmark._builder.anchor_shard_prefix(anchor) for anchor in anchors])
        self.assertGreater(len(set(prefixes)), 1)

    def test_exact_ground_truth_jaccard(self):
        content = "one two three four five six seven\n"
        self.assertEqual(benchmark.exact_ground_truth_jaccard(content, content), 1)
        self.assertEqual(benchmark.exact_ground_truth_jaccard(content, "orbital marine crystal\n"), 0)
        self.assertEqual(benchmark.exact_ground_truth_jaccard("a b c d e f\n", "a b c d e x\n"), 1 / 3)

    def test_ground_truth_eligibility_and_recall(self):
        def result(similarity, rank):
            candidate = {"instructionsSha256": "sha256:target"}
            return {"groundTruthJaccard": similarity, "expectedInstructionsSha256": "sha256:target",
                    "match": {"type": "variant_candidates", "candidates": [candidate] if rank else []},
                    "diagnostic": self.diagnostic(finalRank=rank)}
        quality = benchmark.variant_quality([result(0.8, 1), result(0.9, None), result(0.4, 1)])
        self.assertEqual(quality["groundTruthAtLeast070"]["count"], 2)
        self.assertEqual(quality["groundTruthAtLeast070"]["recallAt1"], 0.5)

    def test_successful_rank_buckets(self):
        items = []
        for rank in (1, 2, 4, None):
            candidates = [{"instructionsSha256": "sha256:wrong"}] * ((rank or 1) - 1)
            if rank is not None:
                candidates.append({"instructionsSha256": "sha256:target"})
            items.append({"groundTruthJaccard": 0.9, "expectedInstructionsSha256": "sha256:target",
                          "match": {"type": "variant_candidates", "candidates": candidates},
                          "diagnostic": self.diagnostic(finalRank=rank)})
        ranks = benchmark.variant_quality(items)["successfulExpectedRanks"]
        self.assertEqual(ranks, {"rank1Count": 1, "rank2to3Count": 1,
                                 "rank4to10Count": 1, "missingCount": 1})

    @staticmethod
    def diagnostic(**overrides):
        return {"finalRank": None, "expectedSharedAnchorPostings": 2,
                "preScoreEligible": True, "candidateGenerationTruncated": False,
                "passesEstimatedSimilarityThreshold": True,
                "estimatedSketchSimilarity": 0.8, **overrides}

    def test_miss_reason_precedence(self):
        self.assertEqual(benchmark.miss_reason(self.diagnostic(expectedSharedAnchorPostings=1)), "insufficient_shared_anchors")
        self.assertEqual(benchmark.miss_reason(self.diagnostic(preScoreEligible=False,
            candidateGenerationTruncated=True)), "pre_score_truncated")
        self.assertEqual(benchmark.miss_reason(self.diagnostic(passesEstimatedSimilarityThreshold=False)),
            "below_estimated_similarity")
        self.assertEqual(benchmark.miss_reason(self.diagnostic()), "outside_final_top10")
        self.assertIsNone(benchmark.miss_reason(self.diagnostic(finalRank=1)))

    def test_shard_balance_excludes_logical_empty(self):
        index = self.make_index()
        (index / "exact" / "01.json.gz").write_bytes(gzip.compress(b"{}", mtime=0))
        metrics = benchmark.index_size_metrics(index)["categories"]["exact"]
        self.assertEqual(metrics["fileCount"], 2)
        self.assertEqual(metrics["nonEmptyFileCount"], 1)
        self.assertEqual(metrics["largestToMeanRatio"], 1)

    def test_details_excludes_source_content(self):
        identifiers = [{"fileSha": "a" * 40, "repoFullName": "owner/repo", "path": "SKILL.md",
                        "content": "PRIVATE-SKILL-CONTENT"}]
        result = {"id": "0:variant_light", "category": "variant_light",
                  "expectedInstructionsSha256": "sha256:target", "groundTruthJaccard": 0.8,
                  "diagnostic": self.diagnostic(finalRank=1), "match": {"type": "variant_candidates"}}
        details = benchmark.details_report([result], identifiers)
        self.assertNotIn("PRIVATE-SKILL-CONTENT", json.dumps(details))
        self.assertEqual(details["queries"][0]["finalRank"], 1)

    def test_benchmark_json_serialization(self):
        output = self.root / "nested" / "report.json"
        benchmark.write_report({"schemaVersion": "0.1", "value": 3}, output)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["value"], 3)
        self.assertTrue(output.read_bytes().endswith(b"\n"))

    def test_missing_source_db_error(self):
        with self.assertRaisesRegex(benchmark.BenchmarkError, "database not found"):
            benchmark.validate_inputs(self.root / "missing.db", self.root / "index", self.root / "dist.js")

    def test_missing_index_error(self):
        db_path = self.make_db()
        with self.assertRaisesRegex(benchmark.BenchmarkError, "index not found"):
            benchmark.validate_inputs(db_path, self.root / "missing-index", self.root / "dist.js")

    def test_missing_compiled_dist_error(self):
        db_path = self.make_db()
        index = self.make_index()
        with self.assertRaisesRegex(benchmark.BenchmarkError, "npm run build"):
            benchmark.validate_inputs(db_path, index, self.root / "missing-dist.js")

    def test_temporary_workspace_cleanup(self):
        with benchmark.temporary_workspace(False) as workspace:
            marker = workspace / "marker"
            marker.write_text("x", encoding="utf-8")
        self.assertFalse(workspace.exists())

    def test_keep_temp_preserves_workspace(self):
        with benchmark.temporary_workspace(True) as workspace:
            (workspace / "marker").write_text("x", encoding="utf-8")
        try:
            self.assertTrue(workspace.is_dir())
        finally:
            shutil.rmtree(workspace, ignore_errors=True)


class ContinuousIntegrationAssumptionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = (benchmark.REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    def test_ci_uses_minimum_permissions_and_safe_trigger(self):
        self.assertIn("permissions:\n  contents: read", self.workflow)
        self.assertNotIn("pull_request_target", self.workflow)
        self.assertNotIn("secrets.", self.workflow)

    def test_ci_uses_required_action_versions(self):
        for action in ("actions/checkout@v7", "actions/setup-node@v7", "actions/setup-python@v7"):
            self.assertIn(action, self.workflow)

    def test_ci_covers_node_22_24_and_windows_24(self):
        self.assertIn("node: [22, 24]", self.workflow)
        self.assertIn("runs-on: windows-latest", self.workflow)
        self.assertIn("node-version: 24", self.workflow)
        self.assertNotIn("node: [22, 24, 26]", self.workflow)

    def test_ci_never_runs_real_benchmark(self):
        self.assertNotIn("benchmark-gitskills", self.workflow)
        self.assertNotIn("gitskills.db", self.workflow.lower())


if __name__ == "__main__":
    unittest.main()
