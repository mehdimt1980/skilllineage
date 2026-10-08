"""Synthetic-only read-only GitSkills SQLite structural preflight tests."""
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("check-gitskills-source.py")
SPEC = importlib.util.spec_from_file_location("skilllineage_source_check", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

class SourceCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="skilllineage-db-check-")
        self.addCleanup(self.temp.cleanup)
        self.file = Path(self.temp.name) / "sample.db"

    def create(self, valid=True):
        fields = ("file_sha TEXT, repo_full_name TEXT, path TEXT, location_class TEXT, "
                  "content TEXT, first_commit_at TEXT, last_commit_at TEXT, history_fetched INTEGER")
        with sqlite3.connect(self.file) as conn:
            conn.execute("CREATE TABLE artifacts (" + (fields if valid else "file_sha TEXT, path TEXT") + ")")
            conn.execute("CREATE TABLE repos (full_name TEXT, stars INTEGER)")

    def test_valid(self):
        self.create()
        MODULE.preflight(self.file)

    def test_missing_columns(self):
        self.create(False)
        with self.assertRaisesRegex(ValueError, "Missing table"):
            MODULE.preflight(self.file)

    def test_invalid_database(self):
        self.file.write_text("not SQLite", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "SQLite database header"):
            MODULE.preflight(self.file)

    def test_missing_database(self):
        with self.assertRaisesRegex(ValueError, "does not exist"):
            MODULE.preflight(self.file)

if __name__ == "__main__":
    unittest.main()
