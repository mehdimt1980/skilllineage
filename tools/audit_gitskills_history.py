"""Historical data quality audit tool for SkillLineage (Phase 11A).

Standard library only. This module is importable and can be run via CLI or tested
using synthetic SQLite fixtures.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from typing import Any


TOOLS_DIR = Path(__file__).resolve().parent

# Load canonical normalization from build-gitskills-index.py
_builder_path = TOOLS_DIR / "build-gitskills-index.py"
_builder_spec = importlib.util.spec_from_file_location(
    "_skilllineage_index_builder", _builder_path
)
if _builder_spec is None or _builder_spec.loader is None:
    raise RuntimeError("Unable to load the canonical Python normalization implementation")
_builder = importlib.util.module_from_spec(_builder_spec)
_builder_spec.loader.exec_module(_builder)
normalize_instructions = _builder.normalize_instructions
instruction_sha256 = _builder.instruction_sha256


class AuditError(RuntimeError):
    """Clear error raised when audit input validation or execution fails."""


def parse_iso_timestamp(val: Any) -> tuple[datetime | None, str]:
    """Parse timestamp without altering source data.

    Returns (datetime_obj_or_None, status) where status is one of:
    - 'null': val is None
    - 'empty': string is empty or whitespace
    - 'valid': successfully parsed ISO timestamp
    - 'unparseable': non-empty string that failed parsing
    """
    if val is None:
        return None, "null"
    s = str(val).strip()
    if not s:
        return None, "empty"

    s_iso = s.replace("Z", "+00:00") if s.endswith("Z") else s
    try:
        dt = datetime.fromisoformat(s_iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
        return dt, "valid"
    except Exception:
        pass

    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            else:
                dt = dt.astimezone(timezone.utc)
            return dt, "valid"
        except Exception:
            continue

    return None, "unparseable"


def _calc_pct(count: int, total: int) -> float:
    if total == 0:
        return 0.0
    return round((count / total) * 100.0, 2)


def _bucket_occurrence_count(count: int) -> str:
    if count == 1:
        return "1"
    if count == 2:
        return "2"
    if 3 <= count <= 5:
        return "3_5"
    if 6 <= count <= 10:
        return "6_10"
    if 11 <= count <= 50:
        return "11_50"
    if 51 <= count <= 100:
        return "51_100"
    return "over100"


def _bucket_temporal_spread(spread_days: float) -> str:
    if spread_days < 1.0:
        return "sameDay"
    if spread_days <= 7.0:
        return "within7Days"
    if spread_days <= 30.0:
        return "within30Days"
    if spread_days <= 180.0:
        return "within180Days"
    if spread_days <= 365.0:
        return "within365Days"
    return "over365Days"


def validate_schema(conn: sqlite3.Connection) -> None:
    """Verify required tables and columns exist in source database."""
    cursor = conn.cursor()
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts';"
    )
    if not cursor.fetchone():
        raise AuditError("Required table 'artifacts' not found in database schema")

    cursor.execute("PRAGMA table_info(artifacts);")
    cols = {row["name"] if isinstance(row, sqlite3.Row) else row[1] for row in cursor.fetchall()}
    required_cols = [
        "file_sha",
        "repo_full_name",
        "path",
        "content",
        "first_commit_at",
        "last_commit_at",
        "history_fetched",
    ]
    for col in required_cols:
        if col not in cols:
            raise AuditError(f"Required column '{col}' not found in 'artifacts' table")


def run_audit(
    db_path: Path | str,
    *,
    keep_temp: bool = False,
    temp_dir: Path | str | None = None,
) -> dict[str, Any]:
    """Execute read-only historical data audit on GitSkills SQLite database."""
    db_file = Path(db_path)
    if not db_file.exists():
        raise AuditError(f"Source database does not exist: {db_file}")

    db_size_bytes = db_file.stat().st_size

    # Open source database in strict read-only mode using URI
    uri = db_file.resolve().as_uri() + "?mode=ro"
    try:
        source_conn = sqlite3.connect(uri, uri=True)
        source_conn.row_factory = sqlite3.Row
    except Exception as exc:
        raise AuditError(f"Failed to open source database read-only: {exc}") from exc

    # Enforce read-only pragma if possible
    try:
        source_conn.execute("PRAGMA query_only = ON;")
    except Exception:
        pass

    # Create temporary database outside the source DB
    tmp_fd, tmp_path_str = tempfile.mkstemp(
        suffix=".db", prefix="skilllineage-audit-", dir=str(temp_dir) if temp_dir else None
    )
    os.close(tmp_fd)
    tmp_path = Path(tmp_path_str)

    temp_conn = sqlite3.connect(tmp_path)
    temp_conn.row_factory = sqlite3.Row

    try:
        validate_schema(source_conn)

        # Configure temp database for performance
        temp_conn.execute("PRAGMA synchronous = OFF;")
        temp_conn.execute("PRAGMA journal_mode = OFF;")
        temp_conn.execute("PRAGMA temp_store = FILE;")

        temp_conn.execute("""
            CREATE TABLE occ (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_sha TEXT NOT NULL,
                repo_full_name TEXT NOT NULL,
                path TEXT NOT NULL,
                history_fetched INTEGER,
                first_commit_raw TEXT,
                last_commit_raw TEXT,
                first_status TEXT NOT NULL,
                last_status TEXT NOT NULL,
                first_epoch REAL,
                last_epoch REAL,
                first_iso TEXT,
                last_iso TEXT
            );
        """)

        # Stream SKILL.md occurrences from source DB
        occ_query = """
            SELECT
                a.file_sha,
                a.repo_full_name,
                a.path,
                a.history_fetched,
                a.first_commit_at,
                a.last_commit_at
            FROM artifacts a
            WHERE (a.path GLOB '*/SKILL.md' OR a.path = 'SKILL.md')
        """
        source_cur = source_conn.execute(occ_query)

        batch: list[tuple[Any, ...]] = []
        BATCH_SIZE = 10000

        for row in source_cur:
            row_path = row["path"] or ""
            basename = row_path.rsplit("/", 1)[-1] if "/" in row_path else row_path
            if basename != "SKILL.md":
                continue

            raw_file_sha = row["file_sha"]
            if not raw_file_sha:
                continue
            file_sha = str(raw_file_sha).lower()
            repo_full_name = str(row["repo_full_name"] or "")

            hf_raw = row["history_fetched"]
            if hf_raw is None:
                hf = None
            elif hf_raw in (1, "1", True, "true", "True"):
                hf = 1
            elif hf_raw in (0, "0", False, "false", "False"):
                hf = 0
            else:
                hf = None

            first_raw = row["first_commit_at"]
            last_raw = row["last_commit_at"]

            first_dt, first_status = parse_iso_timestamp(first_raw)
            last_dt, last_status = parse_iso_timestamp(last_raw)

            first_epoch = first_dt.timestamp() if first_dt else None
            first_iso = first_dt.isoformat(timespec="microseconds").replace("+00:00", "Z") if first_dt else None

            last_epoch = last_dt.timestamp() if last_dt else None
            last_iso = last_dt.isoformat(timespec="microseconds").replace("+00:00", "Z") if last_dt else None

            batch.append((
                file_sha,
                repo_full_name,
                row_path,
                hf,
                str(first_raw) if first_raw is not None else None,
                str(last_raw) if last_raw is not None else None,
                first_status,
                last_status,
                first_epoch,
                last_epoch,
                first_iso,
                last_iso,
            ))

            if len(batch) >= BATCH_SIZE:
                temp_conn.executemany(
                    """
                    INSERT INTO occ (
                        file_sha, repo_full_name, path, history_fetched,
                        first_commit_raw, last_commit_raw, first_status, last_status,
                        first_epoch, last_epoch, first_iso, last_iso
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    batch,
                )
                batch.clear()

        if batch:
            temp_conn.executemany(
                """
                INSERT INTO occ (
                    file_sha, repo_full_name, path, history_fetched,
                    first_commit_raw, last_commit_raw, first_status, last_status,
                    first_epoch, last_epoch, first_iso, last_iso
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                batch,
            )
            batch.clear()
        temp_conn.commit()

        # Create indexes on occurrences
        temp_conn.execute("CREATE INDEX idx_occ_sha ON occ(file_sha);")
        temp_conn.execute("CREATE INDEX idx_occ_repo ON occ(repo_full_name);")

        # Stream representative contents and compute instruction_sha256
        temp_conn.execute("""
            CREATE TABLE file_instructions (
                file_sha TEXT PRIMARY KEY,
                instructions_sha256 TEXT NOT NULL
            );
        """)

        # Match the canonical index builder exactly: case-fold the raw hash and
        # select MAX(content) deterministically for each distinct raw hash. Empty
        # strings are valid content; only NULL content is unindexable.
        rep_query = """
            SELECT
                LOWER(a.file_sha) AS file_sha,
                MAX(a.content) AS content
            FROM artifacts a
            WHERE (a.path GLOB '*/SKILL.md' OR a.path = 'SKILL.md')
              AND a.file_sha IS NOT NULL
            GROUP BY LOWER(a.file_sha)
            ORDER BY LOWER(a.file_sha)
        """
        rep_cur = source_conn.execute(rep_query)
        fi_batch: list[tuple[str, str]] = []

        for row in rep_cur:
            f_sha = str(row["file_sha"]).lower()
            content = row["content"]
            if not f_sha or content is None:
                continue
            try:
                instr_sha = instruction_sha256(content)
                fi_batch.append((f_sha, instr_sha))
            except Exception:
                continue

            if len(fi_batch) >= BATCH_SIZE:
                temp_conn.executemany(
                    "INSERT OR IGNORE INTO file_instructions (file_sha, instructions_sha256) VALUES (?, ?)",
                    fi_batch,
                )
                fi_batch.clear()

        if fi_batch:
            temp_conn.executemany(
                "INSERT OR IGNORE INTO file_instructions (file_sha, instructions_sha256) VALUES (?, ?)",
                fi_batch,
            )
            fi_batch.clear()
        temp_conn.commit()

        temp_conn.execute("CREATE INDEX idx_fi_instr ON file_instructions(instructions_sha256);")

        # Create summary table for exact content
        temp_conn.execute("""
            CREATE TABLE exact_summary AS
            SELECT
                file_sha,
                COUNT(*) as occ_count,
                COUNT(DISTINCT repo_full_name) as repo_count,
                COUNT(DISTINCT path) as path_count,
                SUM(CASE WHEN first_status = 'valid' THEN 1 ELSE 0 END) as valid_first_count,
                SUM(CASE WHEN first_commit_raw IS NOT NULL AND first_commit_raw != '' THEN 1 ELSE 0 END) as present_first_count,
                COUNT(DISTINCT CASE WHEN first_status = 'valid' THEN first_iso ELSE NULL END) as distinct_valid_first_count,
                MIN(CASE WHEN first_status = 'valid' THEN first_epoch ELSE NULL END) as min_first_epoch,
                MAX(CASE WHEN first_status = 'valid' THEN first_epoch ELSE NULL END) as max_first_epoch,
                MIN(CASE WHEN first_status = 'valid' THEN first_iso ELSE NULL END) as min_first_iso,
                MAX(CASE WHEN first_status = 'valid' THEN first_iso ELSE NULL END) as max_first_iso,
                MIN(CASE WHEN last_status = 'valid' THEN last_iso ELSE NULL END) as min_last_iso,
                MAX(CASE WHEN last_status = 'valid' THEN last_iso ELSE NULL END) as max_last_iso
            FROM occ
            GROUP BY file_sha;
        """)

        # Summarize only hashes that the canonical builder can map to a real
        # normalized instruction SHA. Unindexable hashes are counted separately.
        temp_conn.execute("""
            CREATE TABLE instr_summary AS
            SELECT
                fi.instructions_sha256 as instructions_sha256,
                COUNT(DISTINCT occ.file_sha) as raw_variant_count,
                COUNT(*) as occ_count,
                COUNT(DISTINCT occ.repo_full_name) as repo_count,
                SUM(CASE WHEN occ.first_status = 'valid' THEN 1 ELSE 0 END) as valid_first_count,
                MIN(CASE WHEN occ.first_status = 'valid' THEN occ.first_epoch ELSE NULL END) as min_first_epoch,
                MAX(CASE WHEN occ.first_status = 'valid' THEN occ.first_epoch ELSE NULL END) as max_first_epoch,
                MIN(CASE WHEN occ.first_status = 'valid' THEN occ.first_iso ELSE NULL END) as min_first_iso,
                MAX(CASE WHEN occ.first_status = 'valid' THEN occ.first_iso ELSE NULL END) as max_first_iso
            FROM occ
            JOIN file_instructions fi ON occ.file_sha = fi.file_sha
            GROUP BY fi.instructions_sha256;
        """)

        # Calculate metrics
        report = _build_report_payload(source_conn, temp_conn, db_size_bytes)
        return report

    finally:
        source_conn.close()
        temp_conn.close()
        if not keep_temp:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass


def _build_report_payload(
    source_conn: sqlite3.Connection,
    temp_conn: sqlite3.Connection,
    db_size_bytes: int,
) -> dict[str, Any]:
    """Calculate all audit metrics from temp database tables."""
    # 1. Dataset Section
    total_artifact_rows_row = source_conn.execute("SELECT COUNT(*) FROM artifacts;").fetchone()
    total_artifact_rows = total_artifact_rows_row[0] if total_artifact_rows_row else 0

    total_occ = temp_conn.execute("SELECT COUNT(*) FROM occ;").fetchone()[0]
    distinct_exact_hashes = temp_conn.execute("SELECT COUNT(*) FROM exact_summary;").fetchone()[0]
    distinct_repos = temp_conn.execute("SELECT COUNT(DISTINCT repo_full_name) FROM occ;").fetchone()[0]

    dataset_sec = {
        "databaseSizeBytes": db_size_bytes,
        "totalArtifactRows": total_artifact_rows,
        "totalSkillOccurrences": total_occ,
        "distinctSkillRawHashes": distinct_exact_hashes,
        "distinctRepositories": distinct_repos,
    }

    # 2. Occurrence-level Metrics
    hf_true = temp_conn.execute("SELECT COUNT(*) FROM occ WHERE history_fetched = 1;").fetchone()[0]
    hf_false = temp_conn.execute("SELECT COUNT(*) FROM occ WHERE history_fetched = 0;").fetchone()[0]
    hf_null = temp_conn.execute("SELECT COUNT(*) FROM occ WHERE history_fetched IS NULL;").fetchone()[0]

    first_present = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE first_commit_raw IS NOT NULL AND first_commit_raw != '';"
    ).fetchone()[0]
    last_present = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE last_commit_raw IS NOT NULL AND last_commit_raw != '';"
    ).fetchone()[0]
    both_dates = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE first_commit_raw IS NOT NULL AND first_commit_raw != '' AND last_commit_raw IS NOT NULL AND last_commit_raw != '';"
    ).fetchone()[0]
    neither_date = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE (first_commit_raw IS NULL OR first_commit_raw = '') AND (last_commit_raw IS NULL OR last_commit_raw = '');"
    ).fetchone()[0]
    first_only = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE (first_commit_raw IS NOT NULL AND first_commit_raw != '') AND (last_commit_raw IS NULL OR last_commit_raw = '');"
    ).fetchone()[0]
    last_only = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE (first_commit_raw IS NULL OR first_commit_raw = '') AND (last_commit_raw IS NOT NULL AND last_commit_raw != '');"
    ).fetchone()[0]

    hf_true_first_missing = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE history_fetched = 1 AND (first_commit_raw IS NULL OR first_commit_raw = '');"
    ).fetchone()[0]
    hf_true_last_missing = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE history_fetched = 1 AND (last_commit_raw IS NULL OR last_commit_raw = '');"
    ).fetchone()[0]
    hf_false_dates_present = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE history_fetched = 0 AND ((first_commit_raw IS NOT NULL AND first_commit_raw != '') OR (last_commit_raw IS NOT NULL AND last_commit_raw != ''));"
    ).fetchone()[0]
    hf_null_dates_present = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE history_fetched IS NULL AND ((first_commit_raw IS NOT NULL AND first_commit_raw != '') OR (last_commit_raw IS NOT NULL AND last_commit_raw != ''));"
    ).fetchone()[0]

    occurrences_sec = {
        "total": total_occ,
        "historyFetched": {
            "true": {"count": hf_true, "percentage": _calc_pct(hf_true, total_occ)},
            "false": {"count": hf_false, "percentage": _calc_pct(hf_false, total_occ)},
            "null": {"count": hf_null, "percentage": _calc_pct(hf_null, total_occ)},
        },
        "timestamps": {
            "firstCommitAtPresent": {"count": first_present, "percentage": _calc_pct(first_present, total_occ)},
            "lastCommitAtPresent": {"count": last_present, "percentage": _calc_pct(last_present, total_occ)},
            "bothDatesPresent": {"count": both_dates, "percentage": _calc_pct(both_dates, total_occ)},
            "neitherDatePresent": {"count": neither_date, "percentage": _calc_pct(neither_date, total_occ)},
            "firstOnlyPresent": {"count": first_only, "percentage": _calc_pct(first_only, total_occ)},
            "lastOnlyPresent": {"count": last_only, "percentage": _calc_pct(last_only, total_occ)},
        },
        "inconsistencies": {
            "historyFetchedTrueFirstCommitMissing": {
                "count": hf_true_first_missing,
                "percentage": _calc_pct(hf_true_first_missing, total_occ),
            },
            "historyFetchedTrueLastCommitMissing": {
                "count": hf_true_last_missing,
                "percentage": _calc_pct(hf_true_last_missing, total_occ),
            },
            "historyFetchedFalseDatesPresent": {
                "count": hf_false_dates_present,
                "percentage": _calc_pct(hf_false_dates_present, total_occ),
            },
            "historyFetchedNullDatesPresent": {
                "count": hf_null_dates_present,
                "percentage": _calc_pct(hf_null_dates_present, total_occ),
            },
        },
    }

    # 3. Date Validity Audit
    parseable_count = temp_conn.execute(
        "SELECT (SELECT COUNT(*) FROM occ WHERE first_status = 'valid') + (SELECT COUNT(*) FROM occ WHERE last_status = 'valid');"
    ).fetchone()[0]
    unparseable_count = temp_conn.execute(
        "SELECT (SELECT COUNT(*) FROM occ WHERE first_status = 'unparseable') + (SELECT COUNT(*) FROM occ WHERE last_status = 'unparseable');"
    ).fetchone()[0]
    empty_count = temp_conn.execute(
        "SELECT (SELECT COUNT(*) FROM occ WHERE first_status = 'empty') + (SELECT COUNT(*) FROM occ WHERE last_status = 'empty');"
    ).fetchone()[0]

    total_evaluated_dates = parseable_count + unparseable_count + empty_count

    total_eval_pairs = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE first_status = 'valid' AND last_status = 'valid';"
    ).fetchone()[0]
    first_less_last = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE first_status = 'valid' AND last_status = 'valid' AND first_epoch < last_epoch;"
    ).fetchone()[0]
    first_eq_last = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE first_status = 'valid' AND last_status = 'valid' AND first_epoch = last_epoch;"
    ).fetchone()[0]
    first_gt_last = temp_conn.execute(
        "SELECT COUNT(*) FROM occ WHERE first_status = 'valid' AND last_status = 'valid' AND first_epoch > last_epoch;"
    ).fetchone()[0]

    date_validity_sec = {
        "evaluatedTimestamps": {
            "total": total_evaluated_dates,
            "parseable": {"count": parseable_count, "percentage": _calc_pct(parseable_count, total_evaluated_dates)},
            "unparseable": {"count": unparseable_count, "percentage": _calc_pct(unparseable_count, total_evaluated_dates)},
            "emptyStrings": {"count": empty_count, "percentage": _calc_pct(empty_count, total_evaluated_dates)},
        },
        "chronologicalConsistency": {
            "totalEvaluatedPairs": total_eval_pairs,
            "firstLessThanLast": {"count": first_less_last, "percentage": _calc_pct(first_less_last, total_eval_pairs)},
            "firstEqualToLast": {"count": first_eq_last, "percentage": _calc_pct(first_eq_last, total_eval_pairs)},
            "firstGreaterThanLast": {"count": first_gt_last, "percentage": _calc_pct(first_gt_last, total_eval_pairs)},
        },
    }

    # 4. History_fetched Consistency Matrix
    def _matrix_cell(hf_val: int | None, date_state: str) -> dict[str, Any]:
        hf_clause = "history_fetched IS NULL" if hf_val is None else f"history_fetched = {hf_val}"
        if date_state == "both":
            date_clause = "first_commit_raw IS NOT NULL AND first_commit_raw != '' AND last_commit_raw IS NOT NULL AND last_commit_raw != ''"
        elif date_state == "first_only":
            date_clause = "first_commit_raw IS NOT NULL AND first_commit_raw != '' AND (last_commit_raw IS NULL OR last_commit_raw = '')"
        elif date_state == "last_only":
            date_clause = "(first_commit_raw IS NULL OR first_commit_raw = '') AND last_commit_raw IS NOT NULL AND last_commit_raw != ''"
        else:  # neither
            date_clause = "(first_commit_raw IS NULL OR first_commit_raw = '') AND (last_commit_raw IS NULL OR last_commit_raw = '')"

        cnt = temp_conn.execute(f"SELECT COUNT(*) FROM occ WHERE {hf_clause} AND {date_clause};").fetchone()[0]
        return {"count": cnt, "percentage": _calc_pct(cnt, total_occ)}

    matrix_sec = {
        "totalOccurrences": total_occ,
        "matrix": {
            "historyFetchedTrue": {
                "bothDates": _matrix_cell(1, "both"),
                "firstOnly": _matrix_cell(1, "first_only"),
                "lastOnly": _matrix_cell(1, "last_only"),
                "neitherDate": _matrix_cell(1, "neither"),
            },
            "historyFetchedFalse": {
                "bothDates": _matrix_cell(0, "both"),
                "firstOnly": _matrix_cell(0, "first_only"),
                "lastOnly": _matrix_cell(0, "last_only"),
                "neitherDate": _matrix_cell(0, "neither"),
            },
            "historyFetchedNull": {
                "bothDates": _matrix_cell(None, "both"),
                "firstOnly": _matrix_cell(None, "first_only"),
                "lastOnly": _matrix_cell(None, "last_only"),
                "neitherDate": _matrix_cell(None, "neither"),
            },
        },
    }

    # 5. Repository-level Coverage
    repo_stats_cur = temp_conn.execute("""
        SELECT
            repo_full_name,
            COUNT(*) as total_occ,
            SUM(CASE WHEN history_fetched = 1 THEN 1 ELSE 0 END) as h_true_count,
            SUM(CASE WHEN history_fetched = 0 THEN 1 ELSE 0 END) as h_false_count,
            SUM(CASE WHEN history_fetched IS NULL THEN 1 ELSE 0 END) as h_null_count,
            SUM(CASE WHEN first_status = 'valid' OR last_status = 'valid' THEN 1 ELSE 0 END) as valid_date_count
        FROM occ
        GROUP BY repo_full_name
    """)

    all_hf_repos = 0
    mixed_hf_repos = 0
    no_hf_repos = 0
    unknown_hf_repos = 0
    at_least_one_ts_repos = 0
    total_skill_repos = 0

    for r in repo_stats_cur:
        total_skill_repos += 1
        t_occ = r["total_occ"]
        h_t = r["h_true_count"]
        h_f = r["h_false_count"]
        h_n = r["h_null_count"]
        v_d = r["valid_date_count"]

        if h_t == t_occ:
            all_hf_repos += 1
        elif h_f == t_occ:
            no_hf_repos += 1
        elif h_n == t_occ:
            unknown_hf_repos += 1
        else:
            mixed_hf_repos += 1

        if v_d > 0:
            at_least_one_ts_repos += 1

    no_ts_repos = total_skill_repos - at_least_one_ts_repos

    repositories_sec = {
        "totalSkillRepositories": total_skill_repos,
        "historyFetchedCoverage": {
            "allHistoryFetched": {"count": all_hf_repos, "percentage": _calc_pct(all_hf_repos, total_skill_repos)},
            "mixedHistoryFetched": {"count": mixed_hf_repos, "percentage": _calc_pct(mixed_hf_repos, total_skill_repos)},
            "noHistoryFetched": {"count": no_hf_repos, "percentage": _calc_pct(no_hf_repos, total_skill_repos)},
            "unknownHistoryFetched": {"count": unknown_hf_repos, "percentage": _calc_pct(unknown_hf_repos, total_skill_repos)},
        },
        "timestampAvailability": {
            "atLeastOneUsableTimestamp": {
                "count": at_least_one_ts_repos,
                "percentage": _calc_pct(at_least_one_ts_repos, total_skill_repos),
            },
            "noUsableTimestamps": {
                "count": no_ts_repos,
                "percentage": _calc_pct(no_ts_repos, total_skill_repos),
            },
        },
    }

    # 6. Exact-content Group Audit
    exact_single = temp_conn.execute("SELECT COUNT(*) FROM exact_summary WHERE occ_count = 1;").fetchone()[0]
    exact_multi = temp_conn.execute("SELECT COUNT(*) FROM exact_summary WHERE occ_count > 1;").fetchone()[0]

    # Occurrence distribution buckets for exact content
    exact_buckets = {
        "1": 0, "2": 0, "3_5": 0, "6_10": 0, "11_50": 0, "51_100": 0, "over100": 0
    }
    exact_occ_counts_cur = temp_conn.execute("SELECT occ_count FROM exact_summary;")
    for row in exact_occ_counts_cur:
        b = _bucket_occurrence_count(row["occ_count"])
        exact_buckets[b] += 1

    exact_max_occ = temp_conn.execute("SELECT MAX(occ_count) FROM exact_summary;").fetchone()[0] or 0
    exact_max_repos = temp_conn.execute("SELECT MAX(repo_count) FROM exact_summary;").fetchone()[0] or 0

    exact_cov_none = temp_conn.execute("SELECT COUNT(*) FROM exact_summary WHERE valid_first_count = 0;").fetchone()[0]
    exact_cov_complete = temp_conn.execute(
        "SELECT COUNT(*) FROM exact_summary WHERE valid_first_count = occ_count;"
    ).fetchone()[0]
    exact_cov_partial = temp_conn.execute(
        "SELECT COUNT(*) FROM exact_summary WHERE valid_first_count > 0 AND valid_first_count < occ_count;"
    ).fetchone()[0]

    # Multi-occurrence exact group analysis
    multi_no_history = temp_conn.execute(
        "SELECT COUNT(*) FROM exact_summary WHERE occ_count > 1 AND valid_first_count = 0;"
    ).fetchone()[0]
    multi_complete_history = temp_conn.execute(
        "SELECT COUNT(*) FROM exact_summary WHERE occ_count > 1 AND valid_first_count = occ_count;"
    ).fetchone()[0]
    multi_partial_history = temp_conn.execute(
        "SELECT COUNT(*) FROM exact_summary WHERE occ_count > 1 AND valid_first_count > 0 AND valid_first_count < occ_count;"
    ).fetchone()[0]

    multi_all_missing = temp_conn.execute(
        "SELECT COUNT(*) FROM exact_summary WHERE occ_count > 1 AND valid_first_count = 0;"
    ).fetchone()[0]
    multi_one_date = temp_conn.execute(
        "SELECT COUNT(*) FROM exact_summary WHERE occ_count > 1 AND distinct_valid_first_count = 1;"
    ).fetchone()[0]
    multi_multi_dates = temp_conn.execute(
        "SELECT COUNT(*) FROM exact_summary WHERE occ_count > 1 AND distinct_valid_first_count >= 2;"
    ).fetchone()[0]
    multi_mixed_missing_present = temp_conn.execute(
        "SELECT COUNT(*) FROM exact_summary WHERE occ_count > 1 AND valid_first_count > 0 AND valid_first_count < occ_count;"
    ).fetchone()[0]

    # Temporal spread buckets for exact groups with >= 2 distinct valid dates
    exact_spread_buckets = {
        "sameDay": 0, "within7Days": 0, "within30Days": 0, "within180Days": 0, "within365Days": 0, "over365Days": 0
    }
    exact_spread_cur = temp_conn.execute("""
        SELECT min_first_epoch, max_first_epoch
        FROM exact_summary
        WHERE occ_count > 1 AND distinct_valid_first_count >= 2;
    """)
    total_exact_spread_eval = 0
    for row in exact_spread_cur:
        total_exact_spread_eval += 1
        spread_d = max(0.0, (row["max_first_epoch"] - row["min_first_epoch"]) / 86400.0)
        exact_spread_buckets[_bucket_temporal_spread(spread_d)] += 1

    # Top largest exact groups (bounded to 10)
    largest_exact_cur = temp_conn.execute("""
        SELECT
            file_sha,
            occ_count,
            repo_count,
            path_count,
            valid_first_count,
            min_first_iso,
            max_first_iso,
            min_last_iso,
            max_last_iso
        FROM exact_summary
        ORDER BY occ_count DESC, repo_count DESC, file_sha ASC
        LIMIT 10;
    """)
    largest_exact_groups = []
    for row in largest_exact_cur:
        c_val = "complete" if row["valid_first_count"] == row["occ_count"] else ("none" if row["valid_first_count"] == 0 else "partial")
        largest_exact_groups.append({
            "fileSha": row["file_sha"],
            "occurrenceCount": row["occ_count"],
            "distinctRepositoryCount": row["repo_count"],
            "distinctPathCount": row["path_count"],
            "historyCoverage": c_val,
            "earliestObservedFirstCommitAt": row["min_first_iso"],
            "latestObservedFirstCommitAt": row["max_first_iso"],
            "earliestObservedLastCommitAt": row["min_last_iso"],
            "latestObservedLastCommitAt": row["max_last_iso"],
        })

    exact_content_sec = {
        "totalExactGroups": distinct_exact_hashes,
        "occurrenceDistribution": {
            "singleOccurrence": {"count": exact_single, "percentage": _calc_pct(exact_single, distinct_exact_hashes)},
            "multiOccurrence": {"count": exact_multi, "percentage": _calc_pct(exact_multi, distinct_exact_hashes)},
        },
        "occurrenceBuckets": exact_buckets,
        "extremes": {
            "maxOccurrenceCount": exact_max_occ,
            "maxDistinctRepositoryCount": exact_max_repos,
        },
        "historyCoverageAllGroups": {
            "none": {"count": exact_cov_none, "percentage": _calc_pct(exact_cov_none, distinct_exact_hashes)},
            "partial": {"count": exact_cov_partial, "percentage": _calc_pct(exact_cov_partial, distinct_exact_hashes)},
            "complete": {"count": exact_cov_complete, "percentage": _calc_pct(exact_cov_complete, distinct_exact_hashes)},
        },
        "multiOccurrenceAudit": {
            "totalMultiOccurrenceGroups": exact_multi,
            "historyCoverage": {
                "noHistory": {"count": multi_no_history, "percentage": _calc_pct(multi_no_history, exact_multi)},
                "partialHistory": {"count": multi_partial_history, "percentage": _calc_pct(multi_partial_history, exact_multi)},
                "completeHistory": {"count": multi_complete_history, "percentage": _calc_pct(multi_complete_history, exact_multi)},
            },
            "firstCommitDateConsistency": {
                "allDatesMissing": {"count": multi_all_missing, "percentage": _calc_pct(multi_all_missing, exact_multi)},
                "singleDistinctDate": {"count": multi_one_date, "percentage": _calc_pct(multi_one_date, exact_multi)},
                "multipleDistinctDates": {"count": multi_multi_dates, "percentage": _calc_pct(multi_multi_dates, exact_multi)},
                "mixedMissingAndPresent": {"count": multi_mixed_missing_present, "percentage": _calc_pct(multi_mixed_missing_present, exact_multi)},
            },
            "temporalSpread": {
                "totalEvaluatedGroups": total_exact_spread_eval,
                "sameDay": {
                    "count": exact_spread_buckets["sameDay"],
                    "percentage": _calc_pct(exact_spread_buckets["sameDay"], total_exact_spread_eval),
                },
                "within7Days": {
                    "count": exact_spread_buckets["within7Days"],
                    "percentage": _calc_pct(exact_spread_buckets["within7Days"], total_exact_spread_eval),
                },
                "within30Days": {
                    "count": exact_spread_buckets["within30Days"],
                    "percentage": _calc_pct(exact_spread_buckets["within30Days"], total_exact_spread_eval),
                },
                "within180Days": {
                    "count": exact_spread_buckets["within180Days"],
                    "percentage": _calc_pct(exact_spread_buckets["within180Days"], total_exact_spread_eval),
                },
                "within365Days": {
                    "count": exact_spread_buckets["within365Days"],
                    "percentage": _calc_pct(exact_spread_buckets["within365Days"], total_exact_spread_eval),
                },
                "over365Days": {
                    "count": exact_spread_buckets["over365Days"],
                    "percentage": _calc_pct(exact_spread_buckets["over365Days"], total_exact_spread_eval),
                },
            },
        },
        "largestGroups": largest_exact_groups,
    }

    # 7. Normalized-instruction Group Audit
    total_instr_groups = temp_conn.execute("SELECT COUNT(*) FROM instr_summary;").fetchone()[0]
    indexed_raw_hashes = temp_conn.execute("SELECT COUNT(*) FROM file_instructions;").fetchone()[0]
    unindexed_raw_hashes = max(0, distinct_exact_hashes - indexed_raw_hashes)
    single_variant_instr = temp_conn.execute("SELECT COUNT(*) FROM instr_summary WHERE raw_variant_count = 1;").fetchone()[0]
    multi_variant_instr = temp_conn.execute("SELECT COUNT(*) FROM instr_summary WHERE raw_variant_count > 1;").fetchone()[0]

    instr_buckets = {
        "1": 0, "2": 0, "3_5": 0, "6_10": 0, "11_50": 0, "51_100": 0, "over100": 0
    }
    instr_occ_cur = temp_conn.execute("SELECT occ_count FROM instr_summary;")
    for row in instr_occ_cur:
        b = _bucket_occurrence_count(row["occ_count"])
        instr_buckets[b] += 1

    instr_max_occ = temp_conn.execute("SELECT MAX(occ_count) FROM instr_summary;").fetchone()[0] or 0
    instr_max_repos = temp_conn.execute("SELECT MAX(repo_count) FROM instr_summary;").fetchone()[0] or 0
    instr_max_variants = temp_conn.execute("SELECT MAX(raw_variant_count) FROM instr_summary;").fetchone()[0] or 0

    instr_cov_none = temp_conn.execute("SELECT COUNT(*) FROM instr_summary WHERE valid_first_count = 0;").fetchone()[0]
    instr_cov_complete = temp_conn.execute(
        "SELECT COUNT(*) FROM instr_summary WHERE valid_first_count = occ_count;"
    ).fetchone()[0]
    instr_cov_partial = temp_conn.execute(
        "SELECT COUNT(*) FROM instr_summary WHERE valid_first_count > 0 AND valid_first_count < occ_count;"
    ).fetchone()[0]

    multi_var_no_hist = temp_conn.execute(
        "SELECT COUNT(*) FROM instr_summary WHERE raw_variant_count > 1 AND valid_first_count = 0;"
    ).fetchone()[0]
    multi_var_complete_hist = temp_conn.execute(
        "SELECT COUNT(*) FROM instr_summary WHERE raw_variant_count > 1 AND valid_first_count = occ_count;"
    ).fetchone()[0]
    multi_var_partial_hist = temp_conn.execute(
        "SELECT COUNT(*) FROM instr_summary WHERE raw_variant_count > 1 AND valid_first_count > 0 AND valid_first_count < occ_count;"
    ).fetchone()[0]

    # Temporal spread for multi-variant instruction groups
    instr_spread_buckets = {
        "sameDay": 0, "within7Days": 0, "within30Days": 0, "within180Days": 0, "within365Days": 0, "over365Days": 0
    }
    instr_spread_cur = temp_conn.execute("""
        SELECT min_first_epoch, max_first_epoch
        FROM instr_summary
        WHERE raw_variant_count > 1 AND min_first_epoch IS NOT NULL AND max_first_epoch IS NOT NULL AND valid_first_count >= 2;
    """)
    total_instr_spread_eval = 0
    for row in instr_spread_cur:
        total_instr_spread_eval += 1
        spread_d = max(0.0, (row["max_first_epoch"] - row["min_first_epoch"]) / 86400.0)
        instr_spread_buckets[_bucket_temporal_spread(spread_d)] += 1

    largest_instr_cur = temp_conn.execute("""
        SELECT
            instructions_sha256,
            raw_variant_count,
            occ_count,
            repo_count,
            valid_first_count,
            min_first_iso,
            max_first_iso
        FROM instr_summary
        ORDER BY occ_count DESC, repo_count DESC, instructions_sha256 ASC
        LIMIT 10;
    """)
    largest_instr_groups = []
    for row in largest_instr_cur:
        c_val = "complete" if row["valid_first_count"] == row["occ_count"] else ("none" if row["valid_first_count"] == 0 else "partial")
        largest_instr_groups.append({
            "instructionsSha256": row["instructions_sha256"],
            "rawVariantCount": row["raw_variant_count"],
            "occurrenceCount": row["occ_count"],
            "distinctRepositoryCount": row["repo_count"],
            "historyCoverage": c_val,
            "earliestObservedFirstCommitAt": row["min_first_iso"],
            "latestObservedFirstCommitAt": row["max_first_iso"],
        })

    normalized_instructions_sec = {
        "totalInstructionGroups": total_instr_groups,
        "indexedDistinctRawHashes": indexed_raw_hashes,
        "unindexedDistinctRawHashes": unindexed_raw_hashes,
        "rawVariantDistribution": {
            "singleVariant": {"count": single_variant_instr, "percentage": _calc_pct(single_variant_instr, total_instr_groups)},
            "multiVariant": {"count": multi_variant_instr, "percentage": _calc_pct(multi_variant_instr, total_instr_groups)},
        },
        "occurrenceBuckets": instr_buckets,
        "extremes": {
            "maxOccurrenceCount": instr_max_occ,
            "maxDistinctRepositoryCount": instr_max_repos,
            "maxRawVariantCount": instr_max_variants,
        },
        "historyCoverageAllGroups": {
            "none": {"count": instr_cov_none, "percentage": _calc_pct(instr_cov_none, total_instr_groups)},
            "partial": {"count": instr_cov_partial, "percentage": _calc_pct(instr_cov_partial, total_instr_groups)},
            "complete": {"count": instr_cov_complete, "percentage": _calc_pct(instr_cov_complete, total_instr_groups)},
        },
        "multiVariantAudit": {
            "totalMultiVariantGroups": multi_variant_instr,
            "historyCoverage": {
                "noHistory": {"count": multi_var_no_hist, "percentage": _calc_pct(multi_var_no_hist, multi_variant_instr)},
                "partialHistory": {"count": multi_var_partial_hist, "percentage": _calc_pct(multi_var_partial_hist, multi_variant_instr)},
                "completeHistory": {"count": multi_var_complete_hist, "percentage": _calc_pct(multi_var_complete_hist, multi_variant_instr)},
            },
            "temporalSpread": {
                "totalEvaluatedGroups": total_instr_spread_eval,
                "sameDay": {
                    "count": instr_spread_buckets["sameDay"],
                    "percentage": _calc_pct(instr_spread_buckets["sameDay"], total_instr_spread_eval),
                },
                "within7Days": {
                    "count": instr_spread_buckets["within7Days"],
                    "percentage": _calc_pct(instr_spread_buckets["within7Days"], total_instr_spread_eval),
                },
                "within30Days": {
                    "count": instr_spread_buckets["within30Days"],
                    "percentage": _calc_pct(instr_spread_buckets["within30Days"], total_instr_spread_eval),
                },
                "within180Days": {
                    "count": instr_spread_buckets["within180Days"],
                    "percentage": _calc_pct(instr_spread_buckets["within180Days"], total_instr_spread_eval),
                },
                "within365Days": {
                    "count": instr_spread_buckets["within365Days"],
                    "percentage": _calc_pct(instr_spread_buckets["within365Days"], total_instr_spread_eval),
                },
                "over365Days": {
                    "count": instr_spread_buckets["over365Days"],
                    "percentage": _calc_pct(instr_spread_buckets["over365Days"], total_instr_spread_eval),
                },
            },
        },
        "largestGroups": largest_instr_groups,
    }

    # 8. Anomalies and Bounded Examples (max 10 per category)
    unparseable_cur = temp_conn.execute("""
        SELECT repo_full_name, path, file_sha, 'first_commit_at' as field, first_commit_raw as value
        FROM occ WHERE first_status = 'unparseable'
        UNION ALL
        SELECT repo_full_name, path, file_sha, 'last_commit_at' as field, last_commit_raw as value
        FROM occ WHERE last_status = 'unparseable'
        ORDER BY repo_full_name ASC, path ASC, file_sha ASC, field ASC
        LIMIT 10;
    """)
    unparseable_examples = [
        {
            "repoFullName": r["repo_full_name"],
            "path": r["path"],
            "fileSha": r["file_sha"],
            "field": r["field"],
            "value": r["value"],
        }
        for r in unparseable_cur
    ]

    first_gt_last_cur = temp_conn.execute("""
        SELECT repo_full_name, path, file_sha, first_commit_raw, last_commit_raw
        FROM occ
        WHERE first_status = 'valid' AND last_status = 'valid' AND first_epoch > last_epoch
        ORDER BY repo_full_name ASC, path ASC, file_sha ASC
        LIMIT 10;
    """)
    first_gt_last_examples = [
        {
            "repoFullName": r["repo_full_name"],
            "path": r["path"],
            "fileSha": r["file_sha"],
            "firstCommitAt": r["first_commit_raw"],
            "lastCommitAt": r["last_commit_raw"],
        }
        for r in first_gt_last_cur
    ]

    hf_true_missing_cur = temp_conn.execute("""
        SELECT repo_full_name, path, file_sha, history_fetched, first_commit_raw, last_commit_raw
        FROM occ
        WHERE history_fetched = 1 AND (first_commit_raw IS NULL OR first_commit_raw = '' OR last_commit_raw IS NULL OR last_commit_raw = '')
        ORDER BY repo_full_name ASC, path ASC, file_sha ASC
        LIMIT 10;
    """)
    hf_true_missing_examples = [
        {
            "repoFullName": r["repo_full_name"],
            "path": r["path"],
            "fileSha": r["file_sha"],
            "historyFetched": True,
            "firstCommitAt": r["first_commit_raw"],
            "lastCommitAt": r["last_commit_raw"],
        }
        for r in hf_true_missing_cur
    ]

    hf_false_with_dates_cur = temp_conn.execute("""
        SELECT repo_full_name, path, file_sha, history_fetched, first_commit_raw, last_commit_raw
        FROM occ
        WHERE history_fetched = 0 AND (
            (first_commit_raw IS NOT NULL AND first_commit_raw != '') OR
            (last_commit_raw IS NOT NULL AND last_commit_raw != '')
        )
        ORDER BY repo_full_name ASC, path ASC, file_sha ASC
        LIMIT 10;
    """)
    hf_false_with_dates_examples = [
        {
            "repoFullName": r["repo_full_name"],
            "path": r["path"],
            "fileSha": r["file_sha"],
            "historyFetched": False,
            "firstCommitAt": r["first_commit_raw"],
            "lastCommitAt": r["last_commit_raw"],
        }
        for r in hf_false_with_dates_cur
    ]

    conflicting_first_dates_cur = temp_conn.execute("""
        SELECT
            file_sha,
            occ_count,
            distinct_valid_first_count,
            min_first_iso,
            max_first_iso,
            ROUND((max_first_epoch - min_first_epoch) / 86400.0, 2) as spread_days
        FROM exact_summary
        WHERE occ_count > 1 AND distinct_valid_first_count >= 2
        ORDER BY spread_days DESC, occ_count DESC, file_sha ASC
        LIMIT 10;
    """)
    conflicting_first_dates_examples = [
        {
            "fileSha": r["file_sha"],
            "occurrenceCount": r["occ_count"],
            "distinctDatesCount": r["distinct_valid_first_count"],
            "earliestObservedFirstCommitAt": r["min_first_iso"],
            "latestObservedFirstCommitAt": r["max_first_iso"],
            "spreadDays": r["spread_days"],
        }
        for r in conflicting_first_dates_cur
    ]

    anomalies_sec = {
        "unparseableDates": unparseable_examples,
        "firstGreaterThanLast": first_gt_last_examples,
        "historyFetchedTrueMissingDates": hf_true_missing_examples,
        "historyFetchedFalseWithDates": hf_false_with_dates_examples,
        "conflictingFirstDates": conflicting_first_dates_examples,
    }

    # 9. Conservative Interpretation Section
    interpretation_sec = {
        "historicalOriginInferenceSupported": False,
        "earliestObservedEvidencePotentiallySupported": True,
        "notes": [
            "Earlier observed timestamps do not establish original authorship or copying direction.",
            "Missing repository history limits temporal coverage.",
            "Only dataset-observed evidence should be surfaced in later phases.",
        ],
    }

    return {
        "schemaVersion": "0.1",
        "kind": "skilllineage-history-audit",
        "dataset": dataset_sec,
        "occurrences": occurrences_sec,
        "dateValidity": date_validity_sec,
        "historyFetchedMatrix": matrix_sec,
        "repositories": repositories_sec,
        "exactContent": exact_content_sec,
        "normalizedInstructions": normalized_instructions_sec,
        "anomalies": anomalies_sec,
        "interpretation": interpretation_sec,
    }


def format_summary_text(report: dict[str, Any]) -> str:
    """Format a concise human-readable summary of the audit report."""
    dataset = report.get("dataset", {})
    occ = report.get("occurrences", {})
    exact = report.get("exactContent", {})
    instr = report.get("normalizedInstructions", {})
    repos = report.get("repositories", {})

    lines = [
        "=== SkillLineage Historical Data Audit (Phase 11A) ===",
        f"Database size: {dataset.get('databaseSizeBytes', 0) / (1024 * 1024):.2f} MB",
        f"Total Skill occurrences: {dataset.get('totalSkillOccurrences', 0):,}",
        f"Distinct exact content hashes: {dataset.get('distinctSkillRawHashes', 0):,}",
        f"Distinct instruction groups: {instr.get('totalInstructionGroups', 0):,}",
        f"Distinct repositories: {dataset.get('distinctRepositories', 0):,}",
        "",
        "--- Occurrence History Coverage ---",
        f"History fetched (true): {occ.get('historyFetched', {}).get('true', {}).get('count', 0):,} ({occ.get('historyFetched', {}).get('true', {}).get('percentage', 0)}%)",
        f"History fetched (false): {occ.get('historyFetched', {}).get('false', {}).get('count', 0):,} ({occ.get('historyFetched', {}).get('false', {}).get('percentage', 0)}%)",
        f"History fetched (null): {occ.get('historyFetched', {}).get('null', {}).get('count', 0):,} ({occ.get('historyFetched', {}).get('null', {}).get('percentage', 0)}%)",
        f"Both dates present: {occ.get('timestamps', {}).get('bothDatesPresent', {}).get('count', 0):,} ({occ.get('timestamps', {}).get('bothDatesPresent', {}).get('percentage', 0)}%)",
        f"Neither date present: {occ.get('timestamps', {}).get('neitherDatePresent', {}).get('count', 0):,} ({occ.get('timestamps', {}).get('neitherDatePresent', {}).get('percentage', 0)}%)",
        "",
        "--- Multi-Occurrence Conflicts ---",
        f"Exact groups with multiple occurrences: {exact.get('multiOccurrenceAudit', {}).get('totalMultiOccurrenceGroups', 0):,}",
        f"Multi-occurrence with conflicting first dates (2+): {exact.get('multiOccurrenceAudit', {}).get('firstCommitDateConsistency', {}).get('multipleDistinctDates', {}).get('count', 0):,}",
        f"Instruction groups with multiple raw variants: {instr.get('multiVariantAudit', {}).get('totalMultiVariantGroups', 0):,}",
        "",
        "--- Interpretation ---",
        "Historical origin inference supported: NO (evidence only)",
        "Earliest observed evidence potentially supported: YES (conservative)",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Audit historical metadata in GitSkills SQLite database (Phase 11A)."
    )
    parser.add_argument(
        "--db",
        dest="db_path",
        help="Path to source GitSkills SQLite database",
    )
    parser.add_argument(
        "positional_db",
        nargs="?",
        help="Positional database path fallback",
    )
    parser.add_argument(
        "--output",
        "-o",
        dest="output_path",
        help="Path for output JSON report",
    )
    parser.add_argument(
        "positional_output",
        nargs="?",
        help="Positional output path fallback",
    )
    parser.add_argument(
        "--keep-temp",
        action="store_true",
        help="Do not delete temporary SQLite database on exit",
    )
    parser.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        help="Suppress human-readable summary on stdout",
    )

    args = parser.parse_args(argv)

    db_path = args.db_path or args.positional_db
    output_path = args.output_path or args.positional_output

    if not db_path:
        parser.error("A source database path is required via --db or positional argument.")
    if not output_path:
        parser.error("An output JSON path is required via --output or positional argument.")

    try:
        report = run_audit(db_path, keep_temp=args.keep_temp)
    except AuditError as exc:
        print(f"AuditError: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error during audit: {exc}", file=sys.stderr)
        return 1

    out_file = Path(output_path)
    out_file.parent.mkdir(parents=True, exist_ok=True)
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
        f.write("\n")

    if not args.quiet:
        print(format_summary_text(report))
        print(f"\nAuthoritative JSON audit report written to {out_file}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
