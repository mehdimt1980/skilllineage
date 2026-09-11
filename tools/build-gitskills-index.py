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
import sqlite3
import sys
import tempfile
from pathlib import Path


SCHEMA_VERSION = "0.1"
KIND = "skilllineage-exact-index"
SHARD_PREFIX_LENGTH = 2
SHINGLE_SIZE = 5
SHINGLE_HASH_HEX_LENGTH = 24
SKETCH_SIZE = 32
ANCHOR_COUNT = 8
MAX_ANCHOR_POSTINGS = 2000

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

    # 1. Strip UTF-8 BOM
    if text and text[0] == "\ufeff":
        text = text[1:]

    # 2. Strip YAML frontmatter
    if text.startswith("---\n") or text.startswith("---\r\n"):
        after_first = text.index("\n") + 1
        rest = text[after_first:]
        close_idx = _find_frontmatter_close(rest)
        if close_idx != -1:
            text = rest[close_idx:]

    # 3. Normalize line endings
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # 4. Strip trailing spaces and tabs from every line
    text = "\n".join(line.rstrip(" \t") for line in text.split("\n"))

    # 5. Remove leading and trailing blank lines
    text = text.lstrip("\n")
    text = text.rstrip("\n")

    # 6. Exactly one final newline
    text = text + "\n"

    return text


def _find_frontmatter_close(text: str) -> int:
    """
    Find position immediately after the closing '---' line.
    Returns -1 if not found.
    Mirrors TypeScript findFrontmatterClose().
    """
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
    exact_dir.mkdir(parents=True, exist_ok=True)
    instructions_dir.mkdir(parents=True, exist_ok=True)
    sketches_dir.mkdir(parents=True, exist_ok=True)
    anchors_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    # Use a temp file for the instruction-mapping SQLite state
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".db", prefix="skilllineage-build-")
    os.close(tmp_fd)

    try:
        record_count, distinct_hash_count = build_exact_index(conn, exact_dir)
        indexed_count, skipped_count, skipped_hot_anchor_count = build_instruction_index(
            conn, instructions_dir, sketches_dir, anchors_dir, tmp_path
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
            "skippedHotAnchorCount": skipped_hot_anchor_count,
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
    """
    Stream artifacts sorted by file_sha, emit one exact shard per prefix.
    Always writes all 256 shards (empty shards write {}).
    """
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
            # Write the completed shard
            _finalize_exact_shard(current_shard)
            write_gz_shard(exact_dir / f"{current_prefix}.json.gz", current_shard)
            # Fill any skipped empty prefixes
            flush_empty_shards_up_to(prefix)
            current_shard = {}

        current_prefix = prefix
        # Advance the prefix tracker
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

    # Flush last populated shard
    if current_prefix is not None and current_shard:
        _finalize_exact_shard(current_shard)
        write_gz_shard(exact_dir / f"{current_prefix}.json.gz", current_shard)
        # Fill any remaining prefixes after the last populated one
        if next_prefix is not None:
            flush_empty_shards_up_to("zz")  # past all valid hex prefixes

    # Fill any remaining prefixes that had no data at all
    for pfx in ALL_PREFIXES:
        shard_path = exact_dir / f"{pfx}.json.gz"
        if not shard_path.exists():
            write_gz_shard(shard_path, {})

    return record_count, distinct_hash_count


def _finalize_exact_shard(shard_data: dict) -> None:
    """Sort occurrences and keys in-place before writing."""
    for entry in shard_data.values():
        entry["occurrences"].sort(key=lambda o: (o["repoFullName"], o["path"]))
    # Re-order shard_data keys lexicographically (mutates in place via rebuild)
    sorted_keys = sorted(shard_data.keys())
    items = {k: shard_data[k] for k in sorted_keys}
    shard_data.clear()
    shard_data.update(items)


# ---------------------------------------------------------------------------
# Instruction index — streaming via temp SQLite, all 256 shards
# ---------------------------------------------------------------------------

def build_instruction_index(
    conn, instructions_dir: Path, sketches_dir: Path, anchors_dir: Path,
    tmp_db_path: str
):
    """
    Build the instruction index using disk-backed temp SQLite.

    Approach:
      1. Stream representative rows (one per distinct file_sha content)
      2. Normalize content, compute instruction SHA-256
      3. Insert (instruction_sha256, file_sha) pairs into temp SQLite
      4. Stream temp table sorted by instruction_sha256, file_sha
      5. Write instruction shards (all 256, empty ones get {})
    """
    tmp_conn = sqlite3.connect(tmp_db_path)
    try:
        return _populate_instruction_index(
            conn, instructions_dir, sketches_dir, anchors_dir, tmp_conn
        )
    finally:
        tmp_conn.close()


def _populate_instruction_index(
    conn, instructions_dir: Path, sketches_dir: Path, anchors_dir: Path, tmp_conn
):
    """Populate and emit instruction shards using an open temporary database."""
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
            anchor_hash TEXT NOT NULL,
            variant_id TEXT NOT NULL,
            PRIMARY KEY (anchor_hash, variant_id)
        ) WITHOUT ROWID
    """)

    # Select exactly one deterministic representative for every distinct raw
    # SKILL.md hash. Empty-string content is usable; only NULL is missing.
    # MAX is deterministic and harmless for a content-addressed hash: all
    # non-NULL representatives for the same file_sha should have equal content.
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
                "INSERT INTO variant_anchors (anchor_hash, variant_id) VALUES (?, ?)",
                [(anchor, variant_id) for anchor in sketch[:ANCHOR_COUNT]],
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

    # Stream sorted pairs and write instruction shards (all 256)
    stream_query = """
        SELECT instruction_sha256, file_sha
        FROM instr_map
        ORDER BY instruction_sha256, file_sha
    """

    stream_cursor = tmp_conn.execute(stream_query)

    current_prefix = None
    current_shard = {}  # instruction_sha256 -> set of file_sha strings

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

    # Flush last instruction shard
    if current_prefix is not None and current_shard:
        _write_instruction_shard(instructions_dir, current_prefix, current_shard)

    # Write all missing (empty) instruction shards
    for pfx in ALL_PREFIXES:
        shard_path = instructions_dir / f"{pfx}.json.gz"
        if not shard_path.exists():
            write_gz_shard(shard_path, {})

    _write_variant_sketches(tmp_conn, sketches_dir)
    skipped_hot_anchor_count = _write_variant_anchors(tmp_conn, anchors_dir)

    return indexed_count, skipped_count, skipped_hot_anchor_count


def _write_instruction_shard(instructions_dir: Path, prefix: str, shard_data: dict) -> None:
    """
    Finalize and write an instruction shard.
    Sort keys lexicographically; sort each file_sha list lexicographically.
    """
    sorted_shard = {}
    for key in sorted(shard_data.keys()):
        sorted_shard[key] = sorted(shard_data[key])
    write_gz_shard(instructions_dir / f"{prefix}.json.gz", sorted_shard)


def _write_variant_sketches(tmp_conn, sketches_dir: Path) -> None:
    current_prefix = None
    current_shard = {}
    rows = tmp_conn.execute(
        "SELECT variant_id, instructions_sha256, sketch_json "
        "FROM variant_sketches ORDER BY variant_id"
    )
    for variant_id, instr_sha, sketch_json in rows:
        prefix = variant_id[:SHARD_PREFIX_LENGTH]
        if current_prefix is not None and prefix != current_prefix:
            write_gz_shard(sketches_dir / f"{current_prefix}.json.gz", current_shard)
            current_shard = {}
        current_prefix = prefix
        current_shard[variant_id] = {
            "instructionsSha256": instr_sha,
            "sketch": json.loads(sketch_json),
        }
    if current_prefix is not None:
        write_gz_shard(sketches_dir / f"{current_prefix}.json.gz", current_shard)
    _write_missing_shards(sketches_dir)


def _write_variant_anchors(tmp_conn, anchors_dir: Path) -> int:
    skipped = tmp_conn.execute(
        "SELECT COUNT(*) FROM (SELECT anchor_hash FROM variant_anchors "
        "GROUP BY anchor_hash HAVING COUNT(*) > ?)",
        (MAX_ANCHOR_POSTINGS,),
    ).fetchone()[0]
    rows = tmp_conn.execute("""
        SELECT va.anchor_hash, va.variant_id
        FROM variant_anchors va
        JOIN (
            SELECT anchor_hash FROM variant_anchors
            GROUP BY anchor_hash HAVING COUNT(*) <= ?
        ) kept ON kept.anchor_hash = va.anchor_hash
        ORDER BY va.anchor_hash, va.variant_id
    """, (MAX_ANCHOR_POSTINGS,))
    current_prefix = None
    current_shard = {}
    for anchor_hash, variant_id in rows:
        prefix = anchor_hash[:SHARD_PREFIX_LENGTH]
        if current_prefix is not None and prefix != current_prefix:
            write_gz_shard(anchors_dir / f"{current_prefix}.json.gz", current_shard)
            current_shard = {}
        current_prefix = prefix
        current_shard.setdefault(anchor_hash, []).append(variant_id)
    if current_prefix is not None:
        write_gz_shard(anchors_dir / f"{current_prefix}.json.gz", current_shard)
    _write_missing_shards(anchors_dir)
    return skipped


def _write_missing_shards(shards_dir: Path) -> None:
    for prefix in ALL_PREFIXES:
        shard_path = shards_dir / f"{prefix}.json.gz"
        if not shard_path.exists():
            write_gz_shard(shard_path, {})


if __name__ == "__main__":
    main()
