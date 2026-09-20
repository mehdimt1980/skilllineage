#!/usr/bin/env python3
"""
Build a SkillLineage index (exact + instructions + variant candidates) from GitSkills.

Usage:
    python tools/build-gitskills-index.py <gitskills.db> <output-dir>

Standard library only — no pip dependencies.
"""

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


SCHEMA_VERSION = "0.5"
KIND = "skilllineage-exact-index"
SHARD_PREFIX_LENGTH = 2
SHINGLE_SIZE = 5
SHINGLE_HASH_HEX_LENGTH = 24
SKETCH_SIZE = 32
ANCHOR_COUNT = 8
MAX_ANCHOR_POSTINGS = 2000
ANCHOR_SHARD_ROUTING = "sha256-anchor-hex-v1"
SKETCH_SHARD_ROUTING = "variant-id-hex4-v1"
ENRICHMENT_SHARD_ROUTING = "instructions-sha256-hex4-v1"
ENRICHMENT_ALGORITHM = "precomputed-variant-summary-v1"
ENRICHMENT_EXAMPLE_LIMIT = 3


def anchor_shard_prefix(anchor: str) -> str:
    """SHA-256 of the unchanged lowercase anchor hex, truncated to one byte."""
    return hashlib.sha256(anchor.encode("utf-8")).hexdigest()[:SHARD_PREFIX_LENGTH]


def variant_sketch_route(variant_id: str):
    """Return the two-level schema-0.3+ physical route for a variant id."""
    normalized = variant_id.lower()
    if len(normalized) != SHINGLE_HASH_HEX_LENGTH or any(
        ch not in "0123456789abcdef" for ch in normalized
    ):
        raise ValueError(f"invalid variant id for sketch routing: {variant_id}")
    return normalized[:2], normalized[2:4]


def variant_enrichment_route(instructions_sha256: str):
    """Return the schema-0.4 physical route for a normalized instruction hash."""
    normalized = instructions_sha256.lower()
    if len(normalized) != 64 or any(ch not in "0123456789abcdef" for ch in normalized):
        raise ValueError(
            f"invalid instructions SHA-256 for enrichment routing: {instructions_sha256}"
        )
    return normalized[:2], normalized[2:4]


def history_route(hex_hash: str, length: int):
    normalized = hex_hash.lower()
    if len(normalized) != length or any(ch not in "0123456789abcdef" for ch in normalized):
        raise ValueError(f"invalid history hash: {hex_hash}")
    return normalized[:2], normalized[2:4]


# All 256 possible 2-hex prefixes in sorted order
ALL_PREFIXES = [f"{i:02x}" for i in range(256)]


# ---------------------------------------------------------------------------
# Instruction normalization
#
# Must exactly reproduce SkillLineage TypeScript normalizeInstructions().
# Inspect src/fingerprint/fingerprint.ts for the canonical implementation.
# ---------------------------------------------------------------------------
def normalize_instructions(raw: str) -> str:
    """
    Normalize SKILL.md content to its canonical instruction body.

    Rules (must match TypeScript implementation exactly):
    1. Strip UTF-8 BOM if present (U+FEFF at position 0)
    2. Strip YAML frontmatter if present:
       - File must begin with '---\\n' or '---\\r\\n'
       - Strip up to and including the next line that is exactly '---'
    3. Normalize line endings: \\r\\n -> \\n, lone \\r -> \\n
    4. Strip trailing spaces and tabs from every line
    5. Remove leading and trailing blank lines
    6. Ensure exactly one final newline
    """
    text = raw

    if text and text[0] == "\ufeff":
        text = text[1:]

    if text.startswith("---\n") or text.startswith("---\r\n"):
        after_first = text.index("\n") + 1
        rest = text[after_first:]
        close_idx = _find_frontmatter_close(rest)
        if close_idx != -1:
            text = rest[close_idx:]

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(line.rstrip(" \t") for line in text.split("\n"))
    text = text.lstrip("\n")
    text = text.rstrip("\n")
    text = text + "\n"

    return text


def _find_frontmatter_close(text: str) -> int:
    """Find position immediately after the closing '---' line."""
    i = 0
    while i < len(text):
        line_end = text.find("\n", i)
        if line_end == -1:
            break
        line = text[i:line_end].rstrip("\r")
        if line == "---":
            return line_end + 1
        i = line_end + 1
    return -1


def instruction_sha256(content: str) -> str:
    """Compute SHA-256 of normalized instruction bytes, return 64-char hex."""
    normalized = normalize_instructions(content)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


ECMASCRIPT_WHITESPACE_RE = re.compile(
    r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
)


def tokenize_instructions(normalized: str):
    """Mirror TypeScript tokenize(): remove final LF, split on ECMAScript whitespace."""
    stripped = normalized[:-1] if normalized.endswith("\n") else normalized
    if not stripped:
        return []
    return [token for token in ECMASCRIPT_WHITESPACE_RE.split(stripped) if token]


def instruction_sketch(normalized: str):
    """Create the canonical sorted bottom-32 set of 96-bit shingle hashes."""
    tokens = tokenize_instructions(normalized)
    if not tokens:
        shingles = set()
    elif len(tokens) < SHINGLE_SIZE:
        shingles = {" ".join(tokens)}
    else:
        shingles = {
            " ".join(tokens[i:i + SHINGLE_SIZE])
            for i in range(len(tokens) - SHINGLE_SIZE + 1)
        }
    hashes = sorted(
        hashlib.sha256(shingle.encode("utf-8")).hexdigest()[:SHINGLE_HASH_HEX_LENGTH]
        for shingle in shingles
    )
    return hashes[:SKETCH_SIZE]


# ---------------------------------------------------------------------------
# Deterministic gzip
# ---------------------------------------------------------------------------
def write_gz_shard(shard_path: Path, data: dict) -> None:
    """Write data as deterministic gzipped JSON (mtime=0)."""
    shard_path.parent.mkdir(parents=True, exist_ok=True)
    if data:
        json_text = json.dumps(
            data, indent=2, sort_keys=False, ensure_ascii=False
        )
    else:
        json_text = "{}"

    with open(shard_path, "wb") as raw_file:
        with gzip.GzipFile(
            filename="", mode="wb", fileobj=raw_file, mtime=0
        ) as gz:
            gz.write(json_text.encode("utf-8"))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Build a SkillLineage dual index from GitSkills."
    )
    parser.add_argument("database", help="Path to GitSkills SQLite database")
    parser.add_argument("output", help="Output directory for the index")
    parser.add_argument(
        "--source-name", default="GitSkills", help="Source dataset name"
    )
    parser.add_argument(
        "--source-snapshot", default="unknown", help="Source snapshot identifier"
    )
    parser.add_argument(
        "--source-license", default="CC-BY-4.0", help="Source license"
    )
    parser.add_argument(
        "--source-url",
        default="https://huggingface.co/datasets/mvaccargiu/gitskills",
        help="Source URL",
    )
    args = parser.parse_args()

    db_path = Path(args.database)
    out_dir = Path(args.output)

    if not db_path.exists():
        print(f"Error: database not found: {db_path}", file=sys.stderr)
        sys.exit(1)

    exact_dir = out_dir / "exact"
    instructions_dir = out_dir / "instructions"
    sketches_dir = out_dir / "variants" / "sketches"
    anchors_dir = out_dir / "variants" / "anchors"
    enrichment_dir = out_dir / "variants" / "enrichment"
    history_dir = out_dir / "history"

    # Sparse schema namespaces must be cleared when reusing an output directory,
    # otherwise stale files from an older dataset could survive a rebuild.
    if sketches_dir.exists():
        shutil.rmtree(sketches_dir)
    if enrichment_dir.exists():
        shutil.rmtree(enrichment_dir)
    if history_dir.exists():
        shutil.rmtree(history_dir)

    exact_dir.mkdir(parents=True, exist_ok=True)
    instructions_dir.mkdir(parents=True, exist_ok=True)
    sketches_dir.mkdir(parents=True, exist_ok=True)
    anchors_dir.mkdir(parents=True, exist_ok=True)
    enrichment_dir.mkdir(parents=True, exist_ok=True)
    history_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".db", prefix="skilllineage-build-")
    os.close(tmp_fd)

    try:
        record_count, distinct_hash_count = build_exact_index(conn, exact_dir)
        indexed_count, skipped_count, skipped_hot_anchor_count = build_instruction_index(
            conn,
            instructions_dir,
            sketches_dir,
            anchors_dir,
            enrichment_dir,
            history_dir,
            tmp_path,
        )
    finally:
        conn.close()
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": KIND,
        "source": {
            "name": args.source_name,
            "snapshot": args.source_snapshot,
            "license": args.source_license,
            "url": args.source_url,
        },
        "indexes": {
            "exact": {
                "algorithm": "git-blob-sha1",
                "shardPrefixLength": SHARD_PREFIX_LENGTH,
            },
            "instructions": {
                "algorithm": "normalized-instructions-sha256",
                "shardPrefixLength": SHARD_PREFIX_LENGTH,
            },
        },
        "recordCount": record_count,
        "distinctHashCount": distinct_hash_count,
        "instructionIndex": {
            "indexedDistinctContentCount": indexed_count,
            "skippedDistinctContentCount": skipped_count,
        },
        "variantIndex": {
            "algorithm": "bottom-k-token-shingles-v1",
            "shingleSize": SHINGLE_SIZE,
            "shingleHash": "sha256-96",
            "sketchSize": SKETCH_SIZE,
            "anchorCount": ANCHOR_COUNT,
            "maxAnchorPostings": MAX_ANCHOR_POSTINGS,
            "anchorShardRouting": ANCHOR_SHARD_ROUTING,
            "sketchShardRouting": SKETCH_SHARD_ROUTING,
            "enrichment": {
                "algorithm": ENRICHMENT_ALGORITHM,
                "shardRouting": ENRICHMENT_SHARD_ROUTING,
                "exampleLimit": ENRICHMENT_EXAMPLE_LIMIT,
            },
            "skippedHotAnchorCount": skipped_hot_anchor_count,
        },
        "historyIndex": {
            "algorithm": "dataset-observed-history-v1",
            "exactRouting": "git-blob-sha1-hex4-v1",
            "instructionRouting": "instructions-sha256-hex4-v1",
            "semantics": "observed-not-origin",
            "timestampNormalization": "utc-v1",
        },
    }

    manifest_path = out_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=False, ensure_ascii=False)
        f.write("\n")

    print(
        f"Done: {record_count} records, {distinct_hash_count} distinct hashes, "
        f"{indexed_count} instruction-indexed, {skipped_count} skipped, "
        f"written to {out_dir}"
    )


# ---------------------------------------------------------------------------
# Exact index — all 256 shards
# ---------------------------------------------------------------------------
def build_exact_index(conn, exact_dir: Path):
    query = """
        SELECT
            a.file_sha,
            a.repo_full_name,
            a.path,
            a.location_class,
            a.first_commit_at,
            a.last_commit_at,
            a.history_fetched,
            r.stars
        FROM artifacts a
        LEFT JOIN repos r ON a.repo_full_name = r.full_name
        WHERE a.path LIKE '%/SKILL.md'
           OR a.path = 'SKILL.md'
        ORDER BY LOWER(a.file_sha), a.repo_full_name, a.path
    """

    cursor = conn.execute(query)
    record_count = 0
    distinct_hash_count = 0
    previous_hash = None
    current_prefix = None
    current_shard = {}
    prefix_iter = iter(ALL_PREFIXES)
    next_prefix = next(prefix_iter)

    def flush_empty_shards_up_to(target_prefix):
        nonlocal next_prefix
        while next_prefix < target_prefix:
            write_gz_shard(exact_dir / f"{next_prefix}.json.gz", {})
            try:
                next_prefix = next(prefix_iter)
            except StopIteration:
                next_prefix = None
                return

    for row in cursor:
        row_path = row["path"]
        basename = row_path.rsplit("/", 1)[-1] if "/" in row_path else row_path
        if basename != "SKILL.md":
            continue

        file_sha = row["file_sha"]
        if not file_sha:
            continue

        file_sha_lower = file_sha.lower()
        prefix = file_sha_lower[:SHARD_PREFIX_LENGTH]

        if current_prefix is not None and prefix != current_prefix:
            _finalize_exact_shard(current_shard)
            write_gz_shard(exact_dir / f"{current_prefix}.json.gz", current_shard)
            flush_empty_shards_up_to(prefix)
            current_shard = {}

        current_prefix = prefix
        if next_prefix is not None and next_prefix <= prefix:
            while next_prefix is not None and next_prefix <= prefix:
                try:
                    next_prefix = next(prefix_iter)
                except StopIteration:
                    next_prefix = None

        if file_sha_lower != previous_hash:
            distinct_hash_count += 1
            previous_hash = file_sha_lower

        occurrence = {
            "repoFullName": row["repo_full_name"],
            "path": row_path,
            "locationClass": row["location_class"],
            "stars": row["stars"],
            "firstCommitAt": row["first_commit_at"],
            "lastCommitAt": row["last_commit_at"],
            "historyFetched": bool(row["history_fetched"])
            if row["history_fetched"] is not None
            else None,
        }

        if file_sha_lower not in current_shard:
            current_shard[file_sha_lower] = {"copyCount": 0, "occurrences": []}

        entry = current_shard[file_sha_lower]
        entry["copyCount"] += 1
        entry["occurrences"].append(occurrence)
        record_count += 1

    if current_prefix is not None and current_shard:
        _finalize_exact_shard(current_shard)
        write_gz_shard(exact_dir / f"{current_prefix}.json.gz", current_shard)
        if next_prefix is not None:
            flush_empty_shards_up_to("zz")

    for pfx in ALL_PREFIXES:
        shard_path = exact_dir / f"{pfx}.json.gz"
        if not shard_path.exists():
            write_gz_shard(shard_path, {})

    return record_count, distinct_hash_count


def _finalize_exact_shard(shard_data: dict) -> None:
    for entry in shard_data.values():
        entry["occurrences"].sort(key=lambda o: (o["repoFullName"], o["path"]))
    sorted_keys = sorted(shard_data.keys())
    items = {k: shard_data[k] for k in sorted_keys}
    shard_data.clear()
    shard_data.update(items)


# ---------------------------------------------------------------------------
# Instruction index — streaming via temp SQLite, all 256 shards
# ---------------------------------------------------------------------------
def build_instruction_index(
    conn,
    instructions_dir: Path,
    sketches_dir: Path,
    anchors_dir: Path,
    enrichment_dir: Path,
    history_dir: Path,
    tmp_db_path: str,
):
    tmp_conn = sqlite3.connect(tmp_db_path, uri=True)
    try:
        return _populate_instruction_index(
            conn,
            instructions_dir,
            sketches_dir,
            anchors_dir,
            enrichment_dir,
            history_dir,
            tmp_conn,
        )
    finally:
        tmp_conn.close()


def _populate_instruction_index(
    conn,
    instructions_dir: Path,
    sketches_dir: Path,
    anchors_dir: Path,
    enrichment_dir: Path,
    history_dir: Path,
    tmp_conn,
):
    tmp_conn.execute("PRAGMA temp_store = FILE")
    tmp_conn.execute("""
        CREATE TABLE instr_map (
            instruction_sha256 TEXT NOT NULL,
            file_sha TEXT NOT NULL,
            PRIMARY KEY (instruction_sha256, file_sha)
        ) WITHOUT ROWID
    """)
    tmp_conn.execute("""
        CREATE TABLE variant_sketches (
            variant_id TEXT PRIMARY KEY,
            instructions_sha256 TEXT NOT NULL UNIQUE,
            sketch_json TEXT NOT NULL
        ) WITHOUT ROWID
    """)
    tmp_conn.execute("""
        CREATE TABLE variant_anchors (
            route_prefix TEXT NOT NULL,
            anchor_hash TEXT NOT NULL,
            variant_id TEXT NOT NULL,
            PRIMARY KEY (route_prefix, anchor_hash, variant_id)
        ) WITHOUT ROWID
    """)

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

    cursor = conn.execute(rep_query)
    indexed_count = 0
    skipped_count = 0
    batch = []
    BATCH_SIZE = 1000

    for row in cursor:
        file_sha = row[0]
        content = row[1]

        if not file_sha or content is None:
            skipped_count += 1
            continue

        try:
            normalized = normalize_instructions(content)
            instr_sha = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
            sketch = instruction_sketch(normalized)
        except Exception:
            skipped_count += 1
            continue

        batch.append((instr_sha, file_sha.lower()))
        indexed_count += 1

        variant_id = instr_sha[:SHINGLE_HASH_HEX_LENGTH]
        insert = tmp_conn.execute(
            "INSERT OR IGNORE INTO variant_sketches "
            "(variant_id, instructions_sha256, sketch_json) VALUES (?, ?, ?)",
            (variant_id, instr_sha, json.dumps(sketch, separators=(",", ":"))),
        )
        if insert.rowcount == 0:
            existing = tmp_conn.execute(
                "SELECT instructions_sha256 FROM variant_sketches WHERE variant_id = ?",
                (variant_id,),
            ).fetchone()
            if existing is not None and existing[0] != instr_sha:
                raise RuntimeError(
                    "variantId collision: " + variant_id + " maps to both "
                    + existing[0] + " and " + instr_sha
                )
        else:
            tmp_conn.executemany(
                "INSERT INTO variant_anchors (route_prefix, anchor_hash, variant_id) VALUES (?, ?, ?)",
                [
                    (anchor_shard_prefix(anchor), anchor, variant_id)
                    for anchor in sketch[:ANCHOR_COUNT]
                ],
            )

        if len(batch) >= BATCH_SIZE:
            tmp_conn.executemany(
                "INSERT OR IGNORE INTO instr_map (instruction_sha256, file_sha) VALUES (?, ?)",
                batch,
            )
            batch.clear()

    if batch:
        tmp_conn.executemany(
            "INSERT OR IGNORE INTO instr_map (instruction_sha256, file_sha) VALUES (?, ?)",
            batch,
        )
    tmp_conn.commit()

    stream_query = """
        SELECT instruction_sha256, file_sha
        FROM instr_map
        ORDER BY instruction_sha256, file_sha
    """
    stream_cursor = tmp_conn.execute(stream_query)
    current_prefix = None
    current_shard = {}

    for instr_sha, file_sha in stream_cursor:
        prefix = instr_sha[:SHARD_PREFIX_LENGTH]
        if current_prefix is not None and prefix != current_prefix:
            _write_instruction_shard(instructions_dir, current_prefix, current_shard)
            current_shard = {}
        current_prefix = prefix
        if instr_sha not in current_shard:
            current_shard[instr_sha] = []
        if file_sha not in current_shard[instr_sha]:
            current_shard[instr_sha].append(file_sha)

    if current_prefix is not None and current_shard:
        _write_instruction_shard(instructions_dir, current_prefix, current_shard)

    for pfx in ALL_PREFIXES:
        shard_path = instructions_dir / f"{pfx}.json.gz"
        if not shard_path.exists():
            write_gz_shard(shard_path, {})

    _write_variant_sketches(tmp_conn, sketches_dir)
    skipped_hot_anchor_count = _write_variant_anchors(tmp_conn, anchors_dir)
    _write_variant_enrichment(conn, tmp_conn, enrichment_dir)
    _write_history(conn, tmp_conn, history_dir)

    return indexed_count, skipped_count, skipped_hot_anchor_count


def _write_instruction_shard(
    instructions_dir: Path, prefix: str, shard_data: dict
) -> None:
    sorted_shard = {}
    for key in sorted(shard_data.keys()):
        sorted_shard[key] = sorted(shard_data[key])
    write_gz_shard(instructions_dir / f"{prefix}.json.gz", sorted_shard)


def _write_variant_sketches(tmp_conn, sketches_dir: Path) -> None:
    current_route = None
    current_shard = {}
    rows = tmp_conn.execute(
        "SELECT variant_id, instructions_sha256, sketch_json "
        "FROM variant_sketches ORDER BY variant_id"
    )
    for variant_id, instr_sha, sketch_json in rows:
        directory, file_prefix = variant_sketch_route(variant_id)
        route = (directory, file_prefix)
        if current_route is not None and route != current_route:
            write_gz_shard(
                sketches_dir / current_route[0] / f"{current_route[1]}.json.gz",
                current_shard,
            )
            current_shard = {}
        current_route = route
        current_shard[variant_id] = {
            "instructionsSha256": instr_sha,
            "sketch": json.loads(sketch_json),
        }
    if current_route is not None:
        write_gz_shard(
            sketches_dir / current_route[0] / f"{current_route[1]}.json.gz",
            current_shard,
        )


def _write_variant_anchors(tmp_conn, anchors_dir: Path) -> int:
    skipped = tmp_conn.execute(
        "SELECT COUNT(*) FROM (SELECT anchor_hash FROM variant_anchors "
        "GROUP BY anchor_hash HAVING COUNT(*) > ?)",
        (MAX_ANCHOR_POSTINGS,),
    ).fetchone()[0]
    rows = tmp_conn.execute("""
        SELECT va.route_prefix, va.anchor_hash, va.variant_id
        FROM variant_anchors va
        JOIN (
            SELECT anchor_hash FROM variant_anchors
            GROUP BY anchor_hash HAVING COUNT(*) <= ?
        ) kept ON kept.anchor_hash = va.anchor_hash
        ORDER BY va.route_prefix, va.anchor_hash, va.variant_id
    """, (MAX_ANCHOR_POSTINGS,))
    current_prefix = None
    current_shard = {}
    for prefix, anchor_hash, variant_id in rows:
        if current_prefix is not None and prefix != current_prefix:
            write_gz_shard(anchors_dir / f"{current_prefix}.json.gz", current_shard)
            current_shard = {}
        current_prefix = prefix
        current_shard.setdefault(anchor_hash, []).append(variant_id)
    if current_prefix is not None:
        write_gz_shard(anchors_dir / f"{current_prefix}.json.gz", current_shard)
    _write_missing_shards(anchors_dir)
    return skipped


def _write_variant_enrichment(conn, tmp_conn, enrichment_dir: Path) -> None:
    """Build sparse precomputed enrichment summaries with disk-backed staging."""
    source_row = conn.execute("PRAGMA database_list").fetchone()
    source_path = source_row[2] if source_row is not None else None
    if not source_path:
        raise RuntimeError("could not resolve source database path for enrichment")

    tmp_conn.execute(
        "CREATE INDEX IF NOT EXISTS instr_map_file_sha_idx ON instr_map(file_sha)"
    )
    tmp_conn.execute("""
        CREATE TABLE enrichment_occurrences (
            instruction_sha256 TEXT NOT NULL,
            repo_full_name TEXT NOT NULL,
            path TEXT NOT NULL,
            stars INTEGER,
            PRIMARY KEY (instruction_sha256, repo_full_name, path)
        ) WITHOUT ROWID
    """)

    tmp_conn.execute("ATTACH DATABASE ? AS source_db", (Path(source_path).resolve().as_uri() + "?mode=ro",))
    try:
        tmp_conn.execute("""
            INSERT OR IGNORE INTO enrichment_occurrences
                (instruction_sha256, repo_full_name, path, stars)
            SELECT
                im.instruction_sha256,
                a.repo_full_name,
                a.path,
                r.stars
            FROM source_db.artifacts a
            JOIN instr_map im ON im.file_sha = LOWER(a.file_sha)
            LEFT JOIN source_db.repos r ON a.repo_full_name = r.full_name
            WHERE (a.path GLOB '*/SKILL.md' OR a.path = 'SKILL.md')
              AND a.file_sha IS NOT NULL
              AND a.repo_full_name IS NOT NULL
              AND a.path IS NOT NULL
        """)
        tmp_conn.commit()
    finally:
        tmp_conn.execute("DETACH DATABASE source_db")

    tmp_conn.execute("""
        CREATE INDEX enrichment_occurrence_order_idx
        ON enrichment_occurrences (
            instruction_sha256,
            (stars IS NULL),
            stars DESC,
            repo_full_name,
            path
        )
    """)
    tmp_conn.commit()

    raw_counts = tmp_conn.execute("""
        SELECT instruction_sha256, COUNT(*)
        FROM instr_map
        GROUP BY instruction_sha256
        ORDER BY instruction_sha256
    """)
    occurrences = iter(tmp_conn.execute("""
        SELECT instruction_sha256, repo_full_name, path, stars
        FROM enrichment_occurrences
        ORDER BY instruction_sha256,
                 (stars IS NULL),
                 stars DESC,
                 repo_full_name,
                 path
    """))
    current_occurrence = next(occurrences, None)
    current_route = None
    current_shard = {}

    for instr_sha, raw_variant_count in raw_counts:
        while current_occurrence is not None and current_occurrence[0] < instr_sha:
            raise RuntimeError(
                "enrichment staging contains an instruction hash absent from instr_map: "
                + current_occurrence[0]
            )

        copy_count = 0
        examples = []
        while current_occurrence is not None and current_occurrence[0] == instr_sha:
            _, repo_full_name, occurrence_path, stars = current_occurrence
            copy_count += 1
            if len(examples) < ENRICHMENT_EXAMPLE_LIMIT:
                examples.append(
                    {
                        "repoFullName": repo_full_name,
                        "path": occurrence_path,
                        "stars": stars,
                    }
                )
            current_occurrence = next(occurrences, None)

        if copy_count == 0:
            raise RuntimeError(
                "cannot build variant enrichment summary for instruction hash "
                + instr_sha
            )

        directory, file_prefix = variant_enrichment_route(instr_sha)
        route = (directory, file_prefix)
        if current_route is not None and route != current_route:
            write_gz_shard(
                enrichment_dir / current_route[0] / f"{current_route[1]}.json.gz",
                current_shard,
            )
            current_shard = {}
        current_route = route
        current_shard[instr_sha] = {
            "rawVariantCount": raw_variant_count,
            "copyCount": copy_count,
            "examples": examples,
        }

    if current_occurrence is not None:
        raise RuntimeError(
            "enrichment staging contains trailing instruction hash absent from instr_map: "
            + current_occurrence[0]
        )

    if current_route is not None:
        write_gz_shard(
            enrichment_dir / current_route[0] / f"{current_route[1]}.json.gz",
            current_shard,
        )


def _utc_timestamp(value):
    """Parse source timestamps once and serialize comparable UTC microseconds."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    except ValueError:
        return None


def _history_summary():
    return {
        "totalLocationCount": 0,
        "historyFetchedLocationCount": 0,
        "usableLocationCount": 0,
        "chronologyAnomalyCount": 0,
        "conflictingLocationCount": 0,
        "coverage": "none",
        "earliestObserved": None,
        "latestObserved": None,
    }


def _finish_history_summary(summary):
    total = summary["totalLocationCount"]
    usable = summary["usableLocationCount"]
    summary["coverage"] = (
        "none" if usable == 0 else "complete" if usable == total else "partial"
    )
    return summary


def _write_history(conn, tmp_conn, history_dir: Path) -> None:
    """Stage location observations on disk, then stream deterministic summaries."""
    source_row = conn.execute("PRAGMA database_list").fetchone()
    source_path = source_row[2] if source_row is not None else None
    if not source_path:
        raise RuntimeError("could not resolve read-only source database for history")
    tmp_conn.execute("""
        CREATE TABLE history_occurrences (
            kind TEXT NOT NULL,
            group_hash TEXT NOT NULL,
            repo_full_name TEXT NOT NULL,
            path TEXT NOT NULL,
            fetched INTEGER NOT NULL,
            first_at TEXT,
            last_at TEXT,
            anomaly INTEGER NOT NULL
        )
    """)
    tmp_conn.execute("ATTACH DATABASE ? AS source_db", (Path(source_path).resolve().as_uri() + "?mode=ro",))
    try:
        rows = tmp_conn.execute("""
            SELECT LOWER(a.file_sha), im.instruction_sha256,
                   a.repo_full_name, a.path, a.history_fetched,
                   a.first_commit_at, a.last_commit_at
            FROM source_db.artifacts a
            LEFT JOIN instr_map im ON im.file_sha = LOWER(a.file_sha)
            WHERE (a.path GLOB '*/SKILL.md' OR a.path = 'SKILL.md')
              AND a.file_sha IS NOT NULL
              AND a.repo_full_name IS NOT NULL AND a.path IS NOT NULL
        """)
        batch = []
        for file_sha, instr_sha, repo, location_path, fetched, first_raw, last_raw in rows:
            if len(file_sha) != 40 or any(ch not in "0123456789abcdef" for ch in file_sha):
                continue
            first_at = _utc_timestamp(first_raw)
            last_at = _utc_timestamp(last_raw)
            anomaly = int(first_at is not None and last_at is not None and first_at > last_at)
            observation = (repo, location_path, int(bool(fetched)), first_at, last_at, anomaly)
            batch.append(("exact", file_sha, *observation))
            if instr_sha is not None:
                batch.append(("instructions", instr_sha, *observation))
            if len(batch) >= 2000:
                tmp_conn.executemany("INSERT INTO history_occurrences VALUES (?,?,?,?,?,?,?,?)", batch)
                batch.clear()
        if batch:
            tmp_conn.executemany("INSERT INTO history_occurrences VALUES (?,?,?,?,?,?,?,?)", batch)
        tmp_conn.commit()
    finally:
        tmp_conn.execute("DETACH DATABASE source_db")

    tmp_conn.execute("""
        CREATE INDEX history_location_idx ON history_occurrences
        (kind, group_hash, repo_full_name, path)
    """)
    tmp_conn.commit()
    rows = tmp_conn.execute("""
        SELECT kind, group_hash, repo_full_name, path,
               MAX(fetched), MAX(anomaly),
               MIN(CASE WHEN anomaly = 0 THEN first_at END),
               MAX(CASE WHEN anomaly = 0 THEN first_at END),
               MIN(CASE WHEN anomaly = 0 THEN last_at END),
               MAX(CASE WHEN anomaly = 0 THEN last_at END)
        FROM history_occurrences
        GROUP BY kind, group_hash, repo_full_name, path
        ORDER BY kind, group_hash, repo_full_name, path
    """)
    current_group = None
    current_route = None
    shard = {}
    summary = None

    def flush_group():
        nonlocal shard, current_route
        if current_group is None or summary is None:
            return
        if not (summary["historyFetchedLocationCount"] or summary["usableLocationCount"]
                or summary["chronologyAnomalyCount"] or summary["conflictingLocationCount"]):
            return
        kind, group_hash = current_group
        route = history_route(group_hash, 40 if kind == "exact" else 64)
        physical = (kind, *route)
        if current_route is not None and physical != current_route:
            write_gz_shard(history_dir / current_route[0] / current_route[1]
                           / f"{current_route[2]}.json.gz", shard)
            shard = {}
        current_route = physical
        shard[group_hash] = _finish_history_summary(summary)

    for kind, group_hash, repo, location_path, fetched, anomaly, first_min, first_max, last_min, last_max in rows:
        group = (kind, group_hash)
        if group != current_group:
            flush_group()
            current_group = group
            summary = _history_summary()
        summary["totalLocationCount"] += 1
        summary["historyFetchedLocationCount"] += fetched
        conflicting = first_min != first_max or last_min != last_max
        if conflicting:
            summary["conflictingLocationCount"] += 1
        if anomaly:
            summary["chronologyAnomalyCount"] += 1
        if not conflicting and not anomaly and first_min is not None:
            summary["usableLocationCount"] += 1
            observed = {
                "repoFullName": repo, "path": location_path,
                "firstCommitAt": first_min, "lastCommitAt": last_max,
            }
            earliest = summary["earliestObserved"]
            latest = summary["latestObserved"]
            if earliest is None or (first_min, repo, location_path) < (
                earliest["firstCommitAt"], earliest["repoFullName"], earliest["path"]
            ):
                summary["earliestObserved"] = observed
            if latest is None or first_min > latest["firstCommitAt"] or (
                first_min == latest["firstCommitAt"]
                and (repo, location_path) < (latest["repoFullName"], latest["path"])
            ):
                summary["latestObserved"] = observed
    flush_group()
    if current_route is not None:
        write_gz_shard(history_dir / current_route[0] / current_route[1]
                       / f"{current_route[2]}.json.gz", shard)


def _write_missing_shards(shards_dir: Path) -> None:
    for prefix in ALL_PREFIXES:
        shard_path = shards_dir / f"{prefix}.json.gz"
        if not shard_path.exists():
            write_gz_shard(shard_path, {})


if __name__ == "__main__":
    main()
