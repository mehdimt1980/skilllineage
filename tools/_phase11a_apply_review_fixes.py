from pathlib import Path


def replace_exact(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"{label} not found")
    return text.replace(old, new)


impl_path = Path("tools/audit_gitskills_history.py")
text = impl_path.read_text(encoding="utf-8")

old = '''        if dt.tzinfo is None:\n            dt = dt.replace(tzinfo=timezone.utc)\n        return dt, "valid"'''
new = '''        if dt.tzinfo is None:\n            dt = dt.replace(tzinfo=timezone.utc)\n        else:\n            dt = dt.astimezone(timezone.utc)\n        return dt, "valid"'''
count = text.count(old)
if count != 2:
    raise RuntimeError(f"expected two timestamp normalization sites, found {count}")
text = text.replace(old, new)

text = replace_exact(
    text,
    'PRAGMA temp_store = MEMORY;',
    'PRAGMA temp_store = FILE;',
    'temp_store pragma',
)
text = replace_exact(
    text,
    'first_dt.isoformat().replace("+00:00", "Z") if first_dt else None',
    'first_dt.isoformat(timespec="microseconds").replace("+00:00", "Z") if first_dt else None',
    'first timestamp serialization',
)
text = replace_exact(
    text,
    'last_dt.isoformat().replace("+00:00", "Z") if last_dt else None',
    'last_dt.isoformat(timespec="microseconds").replace("+00:00", "Z") if last_dt else None',
    'last timestamp serialization',
)

old_rep = '''        rep_query = """\n            SELECT a.file_sha, a.content\n            FROM artifacts a\n            WHERE (a.path GLOB '*/SKILL.md' OR a.path = 'SKILL.md')\n              AND a.file_sha IS NOT NULL\n              AND a.content IS NOT NULL\n              AND a.content != ''\n            GROUP BY a.file_sha\n        """'''
new_rep = '''        # Match the canonical index builder exactly: case-fold the raw hash and\n        # select MAX(content) deterministically for each distinct raw hash. Empty\n        # strings are valid content; only NULL content is unindexable.\n        rep_query = """\n            SELECT\n                LOWER(a.file_sha) AS file_sha,\n                MAX(a.content) AS content\n            FROM artifacts a\n            WHERE (a.path GLOB '*/SKILL.md' OR a.path = 'SKILL.md')\n              AND a.file_sha IS NOT NULL\n            GROUP BY LOWER(a.file_sha)\n            ORDER BY LOWER(a.file_sha)\n        """'''
text = replace_exact(text, old_rep, new_rep, 'representative-content query')
text = replace_exact(
    text,
    '            if not f_sha or not content:\n',
    '            if not f_sha or content is None:\n',
    'representative-content empty handling',
)

old_instr = '''        # Create summary table for instruction groups\n        temp_conn.execute("""\n            CREATE TABLE instr_summary AS\n            SELECT\n                COALESCE(fi.instructions_sha256, 'unindexed:' || occ.file_sha) as instructions_sha256,\n                COUNT(DISTINCT occ.file_sha) as raw_variant_count,\n                COUNT(*) as occ_count,\n                COUNT(DISTINCT occ.repo_full_name) as repo_count,\n                SUM(CASE WHEN occ.first_status = 'valid' THEN 1 ELSE 0 END) as valid_first_count,\n                MIN(CASE WHEN occ.first_status = 'valid' THEN occ.first_epoch ELSE NULL END) as min_first_epoch,\n                MAX(CASE WHEN occ.first_status = 'valid' THEN occ.first_epoch ELSE NULL END) as max_first_epoch,\n                MIN(CASE WHEN occ.first_status = 'valid' THEN occ.first_iso ELSE NULL END) as min_first_iso,\n                MAX(CASE WHEN occ.first_status = 'valid' THEN occ.first_iso ELSE NULL END) as max_first_iso\n            FROM occ\n            LEFT JOIN file_instructions fi ON occ.file_sha = fi.file_sha\n            GROUP BY COALESCE(fi.instructions_sha256, 'unindexed:' || occ.file_sha);\n        """)'''
new_instr = '''        # Summarize only hashes that the canonical builder can map to a real\n        # normalized instruction SHA. Unindexable hashes are counted separately.\n        temp_conn.execute("""\n            CREATE TABLE instr_summary AS\n            SELECT\n                fi.instructions_sha256 as instructions_sha256,\n                COUNT(DISTINCT occ.file_sha) as raw_variant_count,\n                COUNT(*) as occ_count,\n                COUNT(DISTINCT occ.repo_full_name) as repo_count,\n                SUM(CASE WHEN occ.first_status = 'valid' THEN 1 ELSE 0 END) as valid_first_count,\n                MIN(CASE WHEN occ.first_status = 'valid' THEN occ.first_epoch ELSE NULL END) as min_first_epoch,\n                MAX(CASE WHEN occ.first_status = 'valid' THEN occ.first_epoch ELSE NULL END) as max_first_epoch,\n                MIN(CASE WHEN occ.first_status = 'valid' THEN occ.first_iso ELSE NULL END) as min_first_iso,\n                MAX(CASE WHEN occ.first_status = 'valid' THEN occ.first_iso ELSE NULL END) as max_first_iso\n            FROM occ\n            JOIN file_instructions fi ON occ.file_sha = fi.file_sha\n            GROUP BY fi.instructions_sha256;\n        """)'''
text = replace_exact(text, old_instr, new_instr, 'instruction summary block')

old_counts = '''    total_instr_groups = temp_conn.execute("SELECT COUNT(*) FROM instr_summary;").fetchone()[0]\n    single_variant_instr = temp_conn.execute("SELECT COUNT(*) FROM instr_summary WHERE raw_variant_count = 1;").fetchone()[0]'''
new_counts = '''    total_instr_groups = temp_conn.execute("SELECT COUNT(*) FROM instr_summary;").fetchone()[0]\n    indexed_raw_hashes = temp_conn.execute("SELECT COUNT(*) FROM file_instructions;").fetchone()[0]\n    unindexed_raw_hashes = max(0, distinct_exact_hashes - indexed_raw_hashes)\n    single_variant_instr = temp_conn.execute("SELECT COUNT(*) FROM instr_summary WHERE raw_variant_count = 1;").fetchone()[0]'''
text = replace_exact(text, old_counts, new_counts, 'instruction counts')

old_section = '''    normalized_instructions_sec = {\n        "totalInstructionGroups": total_instr_groups,'''
new_section = '''    normalized_instructions_sec = {\n        "totalInstructionGroups": total_instr_groups,\n        "indexedDistinctRawHashes": indexed_raw_hashes,\n        "unindexedDistinctRawHashes": unindexed_raw_hashes,'''
text = replace_exact(text, old_section, new_section, 'normalized instruction report section')

impl_path.write_text(text, encoding="utf-8", newline="\n")


test_path = Path("tools/test_audit_gitskills_history.py")
tests = test_path.read_text(encoding="utf-8")
marker = '\n\nif __name__ == "__main__":\n    unittest.main()\n'
if marker not in tests:
    raise RuntimeError('test insertion marker not found')
extra = r'''

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
'''
tests = tests.replace(marker, extra + marker)
test_path.write_text(tests, encoding="utf-8", newline="\n")
