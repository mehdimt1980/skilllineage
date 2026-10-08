#!/usr/bin/env python3
"""Read-only, dependency-free structural preflight of a GitSkills SQLite database.

Does not validate content provenance, dataset completeness, privacy or rights.
"""
import argparse
import sqlite3
from contextlib import closing
import sys
from pathlib import Path

REQUIRED = {
    "artifacts": {
        "file_sha", "repo_full_name", "path", "location_class", "content",
        "first_commit_at", "last_commit_at", "history_fetched",
    },
    "repos": {"full_name", "stars"},
}

def preflight(database: Path) -> None:
    if not database.is_file():
        raise ValueError("SQLite database does not exist: " + str(database))
    with database.open("rb") as stream:
        if stream.read(16) != b"SQLite format 3\x00":
            raise ValueError("File does not have a SQLite database header")
    # SQLite URI mode=ro guarantees source is not created or modified.
    uri = database.resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as conn:
        conn.execute("PRAGMA query_only=ON")
        for table, expected in REQUIRED.items():
            cols = {str(row[1]) for row in conn.execute("PRAGMA table_info(" + table + ")")}
            missing = sorted(expected - cols)
            if missing:
                raise ValueError("Missing table or required columns in " + table + ": " + ", ".join(missing))
            conn.execute("SELECT 1 FROM " + table + " LIMIT 1").fetchone()
    print("PASS: expected GitSkills SQLite tables/columns exist: " + str(database))
    print("Read-only structural check, NOT a license, provenance or quality audit.")

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="Official sample or full GitSkills SQLite file")
    args = parser.parse_args()
    try:
        preflight(args.database)
    except (ValueError, sqlite3.DatabaseError, OSError) as error:
        print("ERROR: " + str(error), file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
