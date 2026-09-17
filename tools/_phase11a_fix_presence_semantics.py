from pathlib import Path

impl = Path("tools/audit_gitskills_history.py")
text = impl.read_text(encoding="utf-8")

old = '''    multi_all_missing = temp_conn.execute(\n        "SELECT COUNT(*) FROM exact_summary WHERE occ_count > 1 AND valid_first_count = 0;"\n    ).fetchone()[0]'''
new = '''    # Presence consistency is intentionally distinct from usable-history coverage:\n    # a non-empty but unparseable timestamp is present, even though it is not usable\n    # as historical evidence.\n    multi_all_missing = temp_conn.execute(\n        "SELECT COUNT(*) FROM exact_summary WHERE occ_count > 1 AND present_first_count = 0;"\n    ).fetchone()[0]'''
if old not in text:
    raise RuntimeError("multi_all_missing block not found")
text = text.replace(old, new)

old = '''    multi_mixed_missing_present = temp_conn.execute(\n        "SELECT COUNT(*) FROM exact_summary WHERE occ_count > 1 AND valid_first_count > 0 AND valid_first_count < occ_count;"\n    ).fetchone()[0]'''
new = '''    multi_mixed_missing_present = temp_conn.execute(\n        "SELECT COUNT(*) FROM exact_summary WHERE occ_count > 1 AND present_first_count > 0 AND present_first_count < occ_count;"\n    ).fetchone()[0]'''
if old not in text:
    raise RuntimeError("mixed missing/present block not found")
text = text.replace(old, new)
impl.write_text(text, encoding="utf-8", newline="\n")

tests_path = Path("tools/test_audit_gitskills_history.py")
tests = tests_path.read_text(encoding="utf-8")
marker = '\n\nif __name__ == "__main__":\n    unittest.main()\n'
if marker not in tests:
    raise RuntimeError("test marker not found")
extra = r'''

    def test_exact_presence_consistency_is_not_parseability_coverage(self) -> None:
        """Present-but-invalid timestamps are not mislabeled as missing dates."""
        sha_invalid = "aa" * 20
        sha_mixed = "bb" * 20
        artifacts = [
            {"file_sha": sha_invalid, "repo_full_name": "repo/a", "path": "a/SKILL.md", "content": "Same A\n", "first_commit_at": "bad-date-a", "last_commit_at": None, "history_fetched": 1},
            {"file_sha": sha_invalid, "repo_full_name": "repo/b", "path": "b/SKILL.md", "content": "Same A\n", "first_commit_at": "bad-date-b", "last_commit_at": None, "history_fetched": 1},
            {"file_sha": sha_mixed, "repo_full_name": "repo/c", "path": "c/SKILL.md", "content": "Same B\n", "first_commit_at": "bad-date-c", "last_commit_at": None, "history_fetched": 1},
            {"file_sha": sha_mixed, "repo_full_name": "repo/d", "path": "d/SKILL.md", "content": "Same B\n", "first_commit_at": None, "last_commit_at": None, "history_fetched": 1},
        ]
        report = run_audit(self.create_synthetic_db(artifacts))
        consistency = report["exactContent"]["multiOccurrenceAudit"]["firstCommitDateConsistency"]

        # The first group has no usable timestamp, but both timestamps are present.
        self.assertEqual(consistency["allDatesMissing"]["count"], 0)
        # Only the second group genuinely mixes a present value with a missing value.
        self.assertEqual(consistency["mixedMissingAndPresent"]["count"], 1)
        # Usable-history coverage remains a separate classification: both groups have none.
        self.assertEqual(report["exactContent"]["multiOccurrenceAudit"]["historyCoverage"]["noHistory"]["count"], 2)
'''
tests = tests.replace(marker, extra + marker)
tests_path.write_text(tests, encoding="utf-8", newline="\n")
