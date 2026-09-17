"""Unit tests for the SkillLineage Phase 11A Historical Data Audit tool.

Uses only synthetic SQLite database fixtures. Standard library unittest only.
"""

from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

try:
    from tools import audit_gitskills_history as audit
except ImportError:
    import audit_gitskills_history as audit

AuditError = audit.AuditError
instruction_sha256 = audit.instruction_sha256
normalize_instructions = audit.normalize_instructions
parse_iso_timestamp = audit.parse_iso_timestamp
run_audit = audit.run_audit


class BaseSyntheticDbTestCase(unittest.TestCase):
    """Base test case managing temporary database files."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.dir_path = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def create_synthetic_db(
        self,
        artifacts: list[dict],
        *,
        table_name: str = "artifacts",
        custom_schema: str | None = None,
    ) -> Path:
        db_path = self.dir_path / f"test_{self._testMethodName}.db"
        conn = sqlite3.connect(db_path)
        if custom_schema is not None:
            conn.executescript(custom_schema)
        else:
            conn.execute(f"""
                CREATE TABLE {table_name} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_sha TEXT,
                    repo_full_name TEXT,
                    path TEXT,
                    content TEXT,
                    first_commit_at TEXT,
                    last_commit_at TEXT,
                    history_fetched INTEGER
                )
            """)
            for a in artifacts:
                conn.execute(
                    f"""
                    INSERT INTO {table_name} (
                        file_sha, repo_full_name, path, content,
                        first_commit_at, last_commit_at, history_fetched
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        a.get("file_sha"),
                        a.get("repo_full_name"),
                        a.get("path"),
                        a.get("content"),
                        a.get("first_commit_at"),
                        a.get("last_commit_at"),
                        a.get("history_fetched"),
                    ),
                )
        conn.commit()
        conn.close()
        return db_path


class TestAuditHistory(BaseSyntheticDbTestCase):

    def test_basic_counts_and_path_filtering(self) -> None:
        """Requirement 29: canonical path filtering, exact hashes, repo counts."""
        artifacts = [
            # 1. Canonical root SKILL.md
            {
                "file_sha": "a1" * 20,
                "repo_full_name": "owner/repo-a",
                "path": "SKILL.md",
                "content": "# Skill 1\n",
                "first_commit_at": "2026-01-01T00:00:00Z",
                "last_commit_at": "2026-01-02T00:00:00Z",
                "history_fetched": 1,
            },
            # 2. Canonical nested SKILL.md
            {
                "file_sha": "a1" * 20,  # Duplicate exact hash
                "repo_full_name": "owner/repo-b",
                "path": "nested/dir/SKILL.md",
                "content": "# Skill 1\n",
                "first_commit_at": "2026-01-05T00:00:00Z",
                "last_commit_at": "2026-01-06T00:00:00Z",
                "history_fetched": 1,
            },
            # 3. Another canonical SKILL.md
            {
                "file_sha": "b2" * 20,
                "repo_full_name": "owner/repo-c",
                "path": "other/SKILL.md",
                "content": "# Skill 2\n",
                "first_commit_at": None,
                "last_commit_at": None,
                "history_fetched": 0,
            },
            # 4. Excluded: lowercase skill.md
            {
                "file_sha": "c3" * 20,
                "repo_full_name": "owner/repo-a",
                "path": "skill.md",
                "content": "# Lowercase\n",
                "first_commit_at": "2026-01-01T00:00:00Z",
                "last_commit_at": "2026-01-01T00:00:00Z",
                "history_fetched": 1,
            },
            # 5. Excluded: non-skill file
            {
                "file_sha": "d4" * 20,
                "repo_full_name": "owner/repo-a",
                "path": "README.md",
                "content": "# Readme\n",
                "first_commit_at": "2026-01-01T00:00:00Z",
                "last_commit_at": "2026-01-01T00:00:00Z",
                "history_fetched": 1,
            },
        ]
        db_path = self.create_synthetic_db(artifacts)
        report = run_audit(db_path)

        dataset = report["dataset"]
        self.assertEqual(dataset["totalSkillOccurrences"], 3)
        self.assertEqual(dataset["distinctSkillRawHashes"], 2)
        self.assertEqual(dataset["distinctRepositories"], 3)
        self.assertEqual(dataset["totalArtifactRows"], 5)

    def test_history_fetched_matrix(self) -> None:
        """Requirement 30: history_fetched crossed with date state matrix."""
        artifacts = [
            # true + both
            {"file_sha": "01"*20, "repo_full_name": "r1", "path": "SKILL.md", "content": "A", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-02T00:00:00Z", "history_fetched": 1},
            # true + missing first
            {"file_sha": "02"*20, "repo_full_name": "r2", "path": "SKILL.md", "content": "B", "first_commit_at": None, "last_commit_at": "2026-01-02T00:00:00Z", "history_fetched": 1},
            # true + missing last
            {"file_sha": "03"*20, "repo_full_name": "r3", "path": "SKILL.md", "content": "C", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": None, "history_fetched": 1},
            # true + neither
            {"file_sha": "04"*20, "repo_full_name": "r4", "path": "SKILL.md", "content": "D", "first_commit_at": None, "last_commit_at": None, "history_fetched": 1},
            # false + both dates
            {"file_sha": "05"*20, "repo_full_name": "r5", "path": "SKILL.md", "content": "E", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-02T00:00:00Z", "history_fetched": 0},
            # false + no dates
            {"file_sha": "06"*20, "repo_full_name": "r6", "path": "SKILL.md", "content": "F", "first_commit_at": None, "last_commit_at": None, "history_fetched": 0},
            # null + both dates
            {"file_sha": "07"*20, "repo_full_name": "r7", "path": "SKILL.md", "content": "G", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-02T00:00:00Z", "history_fetched": None},
            # null + no dates
            {"file_sha": "08"*20, "repo_full_name": "r8", "path": "SKILL.md", "content": "H", "first_commit_at": None, "last_commit_at": None, "history_fetched": None},
        ]
        db_path = self.create_synthetic_db(artifacts)
        report = run_audit(db_path)

        matrix = report["historyFetchedMatrix"]["matrix"]
        self.assertEqual(matrix["historyFetchedTrue"]["bothDates"]["count"], 1)
        self.assertEqual(matrix["historyFetchedTrue"]["firstOnly"]["count"], 1)
        self.assertEqual(matrix["historyFetchedTrue"]["lastOnly"]["count"], 1)
        self.assertEqual(matrix["historyFetchedTrue"]["neitherDate"]["count"], 1)

        self.assertEqual(matrix["historyFetchedFalse"]["bothDates"]["count"], 1)
        self.assertEqual(matrix["historyFetchedFalse"]["neitherDate"]["count"], 1)

        self.assertEqual(matrix["historyFetchedNull"]["bothDates"]["count"], 1)
        self.assertEqual(matrix["historyFetchedNull"]["neitherDate"]["count"], 1)

    def test_invalid_dates_and_chronology(self) -> None:
        """Requirement 31: valid timestamps, malformed, empty, first > last, first == last, first < last."""
        artifacts = [
            # first < last (valid)
            {"file_sha": "01"*20, "repo_full_name": "r1", "path": "SKILL.md", "content": "A", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-05T00:00:00Z", "history_fetched": 1},
            # first == last (valid)
            {"file_sha": "02"*20, "repo_full_name": "r2", "path": "SKILL.md", "content": "B", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-01T00:00:00Z", "history_fetched": 1},
            # first > last (anomaly)
            {"file_sha": "03"*20, "repo_full_name": "r3", "path": "SKILL.md", "content": "C", "first_commit_at": "2026-02-01T00:00:00Z", "last_commit_at": "2026-01-01T00:00:00Z", "history_fetched": 1},
            # malformed timestamp string
            {"file_sha": "04"*20, "repo_full_name": "r4", "path": "SKILL.md", "content": "D", "first_commit_at": "invalid-timestamp-value", "last_commit_at": "2026-01-01T00:00:00Z", "history_fetched": 1},
            # empty string timestamp
            {"file_sha": "05"*20, "repo_full_name": "r5", "path": "SKILL.md", "content": "E", "first_commit_at": "", "last_commit_at": "   ", "history_fetched": 1},
        ]
        db_path = self.create_synthetic_db(artifacts)
        report = run_audit(db_path)

        dv = report["dateValidity"]
        self.assertEqual(dv["evaluatedTimestamps"]["unparseable"]["count"], 1)
        self.assertEqual(dv["evaluatedTimestamps"]["emptyStrings"]["count"], 2)
        self.assertEqual(dv["evaluatedTimestamps"]["parseable"]["count"], 7)  # (2 from r1, 2 from r2, 2 from r3, 1 from r4 last)

        chrono = dv["chronologicalConsistency"]
        self.assertEqual(chrono["totalEvaluatedPairs"], 3)
        self.assertEqual(chrono["firstLessThanLast"]["count"], 1)
        self.assertEqual(chrono["firstEqualToLast"]["count"], 1)
        self.assertEqual(chrono["firstGreaterThanLast"]["count"], 1)

        # Verify anomaly bounded list
        anomalies = report["anomalies"]
        self.assertEqual(len(anomalies["firstGreaterThanLast"]), 1)
        self.assertEqual(anomalies["firstGreaterThanLast"][0]["repoFullName"], "r3")
        self.assertEqual(len(anomalies["unparseableDates"]), 1)
        self.assertEqual(anomalies["unparseableDates"][0]["value"], "invalid-timestamp-value")

    def test_exact_content_groups_and_spread(self) -> None:
        """Requirement 32: exact group occurrence counts, history coverage, and temporal spread."""
        sha_dup = "ee" * 20
        artifacts = [
            # Duplicate hash in repo 1: Jan 1 2026
            {"file_sha": sha_dup, "repo_full_name": "r1", "path": "SKILL.md", "content": "Same", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-01T00:00:00Z", "history_fetched": 1},
            # Duplicate hash in repo 2: Jan 15 2026 (14 days spread)
            {"file_sha": sha_dup, "repo_full_name": "r2", "path": "a/SKILL.md", "content": "Same", "first_commit_at": "2026-01-15T00:00:00Z", "last_commit_at": "2026-01-15T00:00:00Z", "history_fetched": 1},
            # Duplicate hash in repo 3: No date
            {"file_sha": sha_dup, "repo_full_name": "r3", "path": "b/SKILL.md", "content": "Same", "first_commit_at": None, "last_commit_at": None, "history_fetched": 0},
            # Single occurrence hash
            {"file_sha": "ff" * 20, "repo_full_name": "r4", "path": "SKILL.md", "content": "Other", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-01T00:00:00Z", "history_fetched": 1},
        ]
        db_path = self.create_synthetic_db(artifacts)
        report = run_audit(db_path)

        exact = report["exactContent"]
        self.assertEqual(exact["totalExactGroups"], 2)
        self.assertEqual(exact["occurrenceDistribution"]["singleOccurrence"]["count"], 1)
        self.assertEqual(exact["occurrenceDistribution"]["multiOccurrence"]["count"], 1)

        multi = exact["multiOccurrenceAudit"]
        self.assertEqual(multi["historyCoverage"]["partialHistory"]["count"], 1)
        self.assertEqual(multi["firstCommitDateConsistency"]["multipleDistinctDates"]["count"], 1)
        self.assertEqual(multi["firstCommitDateConsistency"]["mixedMissingAndPresent"]["count"], 1)

        # 14 days spread falls into within30Days (7 to 30 days)
        self.assertEqual(multi["temporalSpread"]["within30Days"]["count"], 1)
        self.assertEqual(multi["temporalSpread"]["totalEvaluatedGroups"], 1)

    def test_normalized_instruction_groups(self) -> None:
        """Requirement 33: multiple raw variants with same normalized instructions."""
        body = "# Same Instructions Body\n\nPerform task reliably.\n"
        content_a = f"---\nname: skill-a\n---\n{body}"
        content_b = f"---\nname: skill-b\nauthor: test\n---\n{body}"
        content_c = f"{body.replace(chr(10), chr(13) + chr(10))}"  # CRLF variant

        artifacts = [
            {"file_sha": "11" * 20, "repo_full_name": "repo/a", "path": "SKILL.md", "content": content_a, "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-01T00:00:00Z", "history_fetched": 1},
            {"file_sha": "22" * 20, "repo_full_name": "repo/b", "path": "SKILL.md", "content": content_b, "first_commit_at": "2026-02-01T00:00:00Z", "last_commit_at": "2026-02-01T00:00:00Z", "history_fetched": 1},
            {"file_sha": "33" * 20, "repo_full_name": "repo/c", "path": "SKILL.md", "content": content_c, "first_commit_at": "2026-03-01T00:00:00Z", "last_commit_at": "2026-03-01T00:00:00Z", "history_fetched": 1},
            # Unrelated skill
            {"file_sha": "44" * 20, "repo_full_name": "repo/d", "path": "SKILL.md", "content": "# Completely Different\n", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-01T00:00:00Z", "history_fetched": 1},
        ]
        db_path = self.create_synthetic_db(artifacts)
        report = run_audit(db_path)

        instr = report["normalizedInstructions"]
        self.assertEqual(instr["totalInstructionGroups"], 2)
        self.assertEqual(instr["rawVariantDistribution"]["singleVariant"]["count"], 1)
        self.assertEqual(instr["rawVariantDistribution"]["multiVariant"]["count"], 1)

        mv = instr["multiVariantAudit"]
        self.assertEqual(mv["totalMultiVariantGroups"], 1)
        self.assertEqual(mv["historyCoverage"]["completeHistory"]["count"], 1)

        # Largest group check
        largest = instr["largestGroups"][0]
        self.assertEqual(largest["rawVariantCount"], 3)
        self.assertEqual(largest["occurrenceCount"], 3)

    def test_normalization_parity_with_canonical_builder(self) -> None:
        """Requirement 34: normalization parity matches canonical implementation."""
        # 1. Plain
        plain = "# Test Body\n"
        self.assertEqual(normalize_instructions(plain), "# Test Body\n")

        # 2. Frontmatter
        fm = "---\nname: my-skill\n---\n# Test Body\n"
        self.assertEqual(normalize_instructions(fm), "# Test Body\n")

        # 3. CRLF
        crlf = "# Test Body\r\n"
        self.assertEqual(normalize_instructions(crlf), "# Test Body\n")

        # 4. UTF-8 BOM
        bom = "\ufeff# Test Body\n"
        self.assertEqual(normalize_instructions(bom), "# Test Body\n")

        # 5. Trailing whitespace
        trailing = "# Test Body   \t\n"
        self.assertEqual(normalize_instructions(trailing), "# Test Body\n")

        # 6. Hashes match across variants
        h_plain = instruction_sha256(plain)
        self.assertEqual(instruction_sha256(fm), h_plain)
        self.assertEqual(instruction_sha256(crlf), h_plain)
        self.assertEqual(instruction_sha256(bom), h_plain)
        self.assertEqual(instruction_sha256(trailing), h_plain)

    def test_no_source_content_leak(self) -> None:
        """Requirement 35: sentinel content and instruction text must NEVER appear in report."""
        sentinel_secret = "PRIVATE-SKILL-CONTENT-MUST-NOT-LEAK-SECRET-12345"
        artifacts = [
            {
                "file_sha": "a1" * 20,
                "repo_full_name": "owner/repo",
                "path": "SKILL.md",
                "content": f"# Header\n\n{sentinel_secret}\n",
                "first_commit_at": "2026-01-01T00:00:00Z",
                "last_commit_at": "2026-01-01T00:00:00Z",
                "history_fetched": 1,
            }
        ]
        db_path = self.create_synthetic_db(artifacts)
        report = run_audit(db_path)
        serialized = json.dumps(report, indent=2)

        self.assertNotIn(sentinel_secret, serialized)
        self.assertNotIn("# Header", serialized)

    def test_determinism_across_runs(self) -> None:
        """Requirement 36: repeated runs on identical DB produce identical JSON."""
        artifacts = [
            {"file_sha": "01"*20, "repo_full_name": "repo/b", "path": "SKILL.md", "content": "B", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-02T00:00:00Z", "history_fetched": 1},
            {"file_sha": "02"*20, "repo_full_name": "repo/a", "path": "SKILL.md", "content": "A", "first_commit_at": "2026-01-03T00:00:00Z", "last_commit_at": "2026-01-04T00:00:00Z", "history_fetched": 0},
        ]
        db_path = self.create_synthetic_db(artifacts)
        report1 = run_audit(db_path)
        report2 = run_audit(db_path)

        json1 = json.dumps(report1, indent=2, ensure_ascii=False)
        json2 = json.dumps(report2, indent=2, ensure_ascii=False)
        self.assertEqual(json1, json2)

    def test_source_database_read_only(self) -> None:
        """Requirement 37: source database is not modified in any way."""
        artifacts = [
            {"file_sha": "01"*20, "repo_full_name": "repo/a", "path": "SKILL.md", "content": "A", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-02T00:00:00Z", "history_fetched": 1}
        ]
        db_path = self.create_synthetic_db(artifacts)
        size_before = db_path.stat().st_size

        conn = sqlite3.connect(db_path)
        count_before = conn.execute("SELECT COUNT(*) FROM artifacts;").fetchone()[0]
        schema_before = conn.execute("SELECT sql FROM sqlite_master;").fetchall()
        conn.close()

        _ = run_audit(db_path)

        conn = sqlite3.connect(db_path)
        count_after = conn.execute("SELECT COUNT(*) FROM artifacts;").fetchone()[0]
        schema_after = conn.execute("SELECT sql FROM sqlite_master;").fetchall()
        conn.close()

        self.assertEqual(count_before, count_after)
        self.assertEqual(schema_before, schema_after)
        self.assertEqual(size_before, db_path.stat().st_size)

    def test_large_group_buckets(self) -> None:
        """Requirement 38: occurrence distribution bucket boundaries 1, 2, 3-5, 6-10, 11-50, 51-100, >100."""
        # Create exact groups with sizes: 1, 2, 3, 5, 6, 10, 11, 50, 51, 100, 101
        target_sizes = [1, 2, 3, 5, 6, 10, 11, 50, 51, 100, 101]
        artifacts = []
        for group_idx, size in enumerate(target_sizes):
            sha = f"{group_idx:02x}" * 20
            for item_idx in range(size):
                artifacts.append({
                    "file_sha": sha,
                    "repo_full_name": f"repo/{group_idx}",
                    "path": f"path_{item_idx}/SKILL.md",
                    "content": f"Content {group_idx}",
                    "first_commit_at": "2026-01-01T00:00:00Z",
                    "last_commit_at": "2026-01-01T00:00:00Z",
                    "history_fetched": 1,
                })
        db_path = self.create_synthetic_db(artifacts)
        report = run_audit(db_path)

        buckets = report["exactContent"]["occurrenceBuckets"]
        self.assertEqual(buckets["1"], 1)
        self.assertEqual(buckets["2"], 1)
        self.assertEqual(buckets["3_5"], 2)   # 3 and 5
        self.assertEqual(buckets["6_10"], 2)  # 6 and 10
        self.assertEqual(buckets["11_50"], 2) # 11 and 50
        self.assertEqual(buckets["51_100"], 2)# 51 and 100
        self.assertEqual(buckets["over100"], 1)# 101

    def test_bounded_examples(self) -> None:
        """Requirement 39: max 10 examples per anomaly category, sorted deterministically."""
        artifacts = []
        # Create 15 unparseable dates
        for i in range(15):
            artifacts.append({
                "file_sha": f"{i:02x}" * 20,
                "repo_full_name": f"repo/{i:02d}",
                "path": "SKILL.md",
                "content": "A",
                "first_commit_at": f"bad-date-{i}",
                "last_commit_at": "2026-01-01T00:00:00Z",
                "history_fetched": 1,
            })
        db_path = self.create_synthetic_db(artifacts)
        report = run_audit(db_path)

        unparseable = report["anomalies"]["unparseableDates"]
        self.assertEqual(len(unparseable), 10)
        # Verify sorted
        repos = [item["repoFullName"] for item in unparseable]
        self.assertEqual(repos, sorted(repos))

    def test_missing_schema_validation(self) -> None:
        """Requirement 40: fail clearly on missing tables or columns."""
        # Missing artifacts table
        db_no_table = self.create_synthetic_db([], custom_schema="CREATE TABLE repos (id INT);")
        with self.assertRaises(AuditError) as ctx:
            run_audit(db_no_table)
        self.assertIn("Required table 'artifacts' not found", str(ctx.exception))

        # Missing first_commit_at column
        db_no_col = self.create_synthetic_db([], custom_schema="""
            CREATE TABLE artifacts (
                id INTEGER PRIMARY KEY,
                file_sha TEXT,
                repo_full_name TEXT,
                path TEXT,
                content TEXT,
                last_commit_at TEXT,
                history_fetched INTEGER
            );
        """)
        with self.assertRaises(AuditError) as ctx:
            run_audit(db_no_col)
        self.assertIn("Required column 'first_commit_at' not found", str(ctx.exception))


    def test_builder_representative_content_parity_and_casefolded_sha(self) -> None:
        """Representative content mirrors LOWER(file_sha) + MAX(content)."""
        raw_sha_upper = "AB" * 20
        raw_sha_lower = raw_sha_upper.lower()
        artifacts = [
            {"file_sha": raw_sha_upper, "repo_full_name": "repo/a", "path": "SKILL.md", "content": "Alpha\n", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-01T00:00:00Z", "history_fetched": 1},
            {"file_sha": raw_sha_lower, "repo_full_name": "repo/b", "path": "nested/SKILL.md", "content": "Zulu\n", "first_commit_at": "2026-01-02T00:00:00Z", "last_commit_at": "2026-01-02T00:00:00Z", "history_fetched": 1},
        ]
        db_path = self.create_synthetic_db(artifacts)
        report = run_audit(db_path)

        instr = report["normalizedInstructions"]
        self.assertEqual(report["dataset"]["distinctSkillRawHashes"], 1)
        self.assertEqual(instr["indexedDistinctRawHashes"], 1)
        self.assertEqual(instr["unindexedDistinctRawHashes"], 0)
        self.assertEqual(instr["totalInstructionGroups"], 1)
        self.assertEqual(instr["largestGroups"][0]["instructionsSha256"], instruction_sha256("Zulu\n"))
        self.assertEqual(instr["largestGroups"][0]["occurrenceCount"], 2)

    def test_timezone_offsets_canonicalize_to_same_observed_instant(self) -> None:
        """Equivalent offset timestamps are one UTC observation, not a conflict."""
        sha = "cd" * 20
        artifacts = [
            {"file_sha": sha, "repo_full_name": "repo/a", "path": "SKILL.md", "content": "Same\n", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-01T01:00:00Z", "history_fetched": 1},
            {"file_sha": sha, "repo_full_name": "repo/b", "path": "nested/SKILL.md", "content": "Same\n", "first_commit_at": "2025-12-31T19:00:00-05:00", "last_commit_at": "2025-12-31T20:00:00-05:00", "history_fetched": 1},
        ]
        db_path = self.create_synthetic_db(artifacts)
        report = run_audit(db_path)

        consistency = report["exactContent"]["multiOccurrenceAudit"]["firstCommitDateConsistency"]
        self.assertEqual(consistency["singleDistinctDate"]["count"], 1)
        self.assertEqual(consistency["multipleDistinctDates"]["count"], 0)
        largest = report["exactContent"]["largestGroups"][0]
        self.assertEqual(largest["earliestObservedFirstCommitAt"], "2026-01-01T00:00:00.000000Z")
        self.assertEqual(largest["latestObservedFirstCommitAt"], "2026-01-01T00:00:00.000000Z")

    def test_unindexed_raw_hashes_are_excluded_from_instruction_groups(self) -> None:
        """Unindexable raw hashes are counted separately, never pseudo-grouped."""
        artifacts = [
            {"file_sha": "11" * 20, "repo_full_name": "repo/a", "path": "SKILL.md", "content": None, "first_commit_at": None, "last_commit_at": None, "history_fetched": 0},
            {"file_sha": "22" * 20, "repo_full_name": "repo/b", "path": "SKILL.md", "content": "Indexable\n", "first_commit_at": "2026-01-01T00:00:00Z", "last_commit_at": "2026-01-01T00:00:00Z", "history_fetched": 1},
        ]
        db_path = self.create_synthetic_db(artifacts)
        report = run_audit(db_path)

        instr = report["normalizedInstructions"]
        self.assertEqual(report["dataset"]["distinctSkillRawHashes"], 2)
        self.assertEqual(instr["indexedDistinctRawHashes"], 1)
        self.assertEqual(instr["unindexedDistinctRawHashes"], 1)
        self.assertEqual(instr["totalInstructionGroups"], 1)
        self.assertNotIn("unindexed:", json.dumps(report))


if __name__ == "__main__":
    unittest.main()
