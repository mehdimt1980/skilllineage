#!/usr/bin/env python3
"""Create a synthetic GitSkills-compatible SQLite database for testing."""

import json
import sqlite3
import sys


def main():
    if len(sys.argv) != 3:
        print("Usage: create-test-db.py <output.db> <fixture.json>", file=sys.stderr)
        sys.exit(1)

    db_path = sys.argv[1]
    fixture_path = sys.argv[2]

    with open(fixture_path, "r", encoding="utf-8") as f:
        records = json.load(f)

    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE repos (
            full_name TEXT PRIMARY KEY,
            stars INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE artifacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_sha TEXT,
            repo_full_name TEXT,
            path TEXT,
            location_class TEXT,
            first_commit_at TEXT,
            last_commit_at TEXT,
            history_fetched INTEGER,
            content TEXT
        )
    """)

    for repo in records.get("repos", []):
        conn.execute(
            "INSERT INTO repos (full_name, stars) VALUES (?, ?)",
            (repo["full_name"], repo.get("stars")),
        )

    for art in records.get("artifacts", []):
        conn.execute(
            """INSERT INTO artifacts
               (file_sha, repo_full_name, path, location_class,
                first_commit_at, last_commit_at, history_fetched, content)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                art["file_sha"],
                art["repo_full_name"],
                art["path"],
                art.get("location_class"),
                art.get("first_commit_at"),
                art.get("last_commit_at"),
                art.get("history_fetched"),
                art.get("content"),  # None -> NULL in SQLite
            ),
        )

    conn.commit()
    conn.close()


if __name__ == "__main__":
    main()
