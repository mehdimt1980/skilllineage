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

    def test_category_size_recurses_into_nested_sketch_routes(self):
        sketches = self.root / "variants" / "sketches"
        for route, payload in {
            ("a1", "b2"): {"a1b2": {"instructionsSha256": "f" * 64, "sketch": ["01"]}},
            ("c3", "d4"): {"c3d4": {"instructionsSha256": "e" * 64, "sketch": ["02"]}},
        }.items():
            directory, filename = route
            target = sketches / directory / f"{filename}.json.gz"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(gzip.compress(json.dumps(payload).encode("utf-8"), mtime=0))

        metrics = benchmark.category_size(sketches)
        self.assertEqual(metrics["fileCount"], 2)
        self.assertEqual(metrics["nonEmptyFileCount"], 2)
        self.assertGreater(metrics["bytes"], 0)
        self.assertGreater(metrics["smallestNonEmptyShardBytes"], 0)
        self.assertGreater(metrics["largestShardBytes"], 0)


if __name__ == "__main__":
    unittest.main()
