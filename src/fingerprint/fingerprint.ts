import { createHash } from "node:crypto";
import { readFile, stat, readdir, lstat } from "node:fs/promises";
import path from "node:path";

import type {
  FingerprintReport,
  InventoryFile,
} from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FingerprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FingerprintError";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fingerprint(
  skillDir: string,
  toolVersion: string,
): Promise<FingerprintReport> {
  // Validate target directory
  const resolved = path.resolve(skillDir);

  let dirStat;
  try {
    dirStat = await stat(resolved);
  } catch {
    throw new FingerprintError(`Path does not exist: ${resolved}`);
  }
  if (!dirStat.isDirectory()) {
    throw new FingerprintError(`Not a directory: ${resolved}`);
  }

  // Validate SKILL.md exists
  const skillMdPath = path.join(resolved, "SKILL.md");
  try {
    await stat(skillMdPath);
  } catch {
    throw new FingerprintError(`No SKILL.md found in: ${resolved}`);
  }

  // Read raw SKILL.md
  const skillMdRaw = await readFile(skillMdPath);

  // Enumerate files
  const files = await enumerateFiles(resolved, "");

  // Sort lexicographically by POSIX path
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Build inventory with per-file hashes
  const inventory: InventoryFile[] = [];
  let totalBytes = 0;

  // Pre-read all files and store raw bytes for bundle hashing
  const fileEntries: Array<{ posixPath: string; raw: Buffer; size: number }> =
    [];

  for (const f of files) {
    const absPath = path.join(resolved, f.nativePath);
    const raw = await readFile(absPath);
    const size = raw.byteLength;
    totalBytes += size;

    inventory.push({
      path: f.path,
      sizeBytes: size,
      sha256: prefixedSha256(raw),
    });

    fileEntries.push({ posixPath: f.path, raw, size });
  }

  // Compute fingerprints
  const skillMdSha256 = prefixedSha256(skillMdRaw);
  const gitBlobSha1 = computeGitBlobSha1(skillMdRaw);
  const instructionsSha256 = prefixedSha256(
    Buffer.from(normalizeInstructions(skillMdRaw.toString("utf-8")), "utf-8"),
  );
  const bundleSha256 = computeBundleHash(fileEntries);

  return {
    schemaVersion: "0.1",
    tool: {
      name: "skilllineage",
      version: toolVersion,
    },
    skill: {
      entrypoint: "SKILL.md",
    },
    fingerprints: {
      skillMdSha256,
      gitBlobSha1,
      instructionsSha256,
      bundleSha256,
    },
    inventory: {
      fileCount: inventory.length,
      totalBytes,
      files: inventory,
    },
  };
}

// ---------------------------------------------------------------------------
// Instruction normalization (exported for testing)
// ---------------------------------------------------------------------------

export function normalizeInstructions(raw: string): string {
  let text = raw;

  // Strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  // Strip YAML frontmatter: must start at the very beginning with ---
  // followed by a closing --- line.
  if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
    const afterFirstDelimiter = text.indexOf("\n") + 1;
    const rest = text.slice(afterFirstDelimiter);

    // Find closing --- on its own line
    const closingIdx = findFrontmatterClose(rest);
    if (closingIdx !== -1) {
      text = rest.slice(closingIdx);
    }
  }

  // Normalize line endings to \n
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove trailing spaces and tabs from every line
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");

  // Remove blank lines at the beginning and end
  text = text.replace(/^\n+/, "").replace(/\n+$/, "");

  // Ensure exactly one final newline
  text = text + "\n";

  return text;
}

/**
 * Find the closing `---` line in content that follows the opening `---` line.
 * Returns the index immediately after the closing `---\n`.
 */
function findFrontmatterClose(text: string): number {
  let i = 0;
  while (i < text.length) {
    const lineEnd = text.indexOf("\n", i);
    if (lineEnd === -1) break;

    const line = text.slice(i, lineEnd).replace(/\r$/, "");
    if (line === "---") {
      return lineEnd + 1;
    }
    i = lineEnd + 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// File enumeration
// ---------------------------------------------------------------------------

interface FileEntry {
  /** POSIX-style relative path */
  path: string;
  /** Native relative path for filesystem access */
  nativePath: string;
}

async function enumerateFiles(
  root: string,
  rel: string,
): Promise<FileEntry[]> {
  const result: FileEntry[] = [];
  const absDir = rel ? path.join(root, rel) : root;
  const entries = await readdir(absDir, { withFileTypes: true });

  for (const entry of entries) {
    const nativeRel = rel ? path.join(rel, entry.name) : entry.name;
    const posixRel = nativeRel.split(path.sep).join("/");
    const absPath = path.join(root, nativeRel);

    // Skip .git directory
    if (entry.name === ".git" && entry.isDirectory()) {
      continue;
    }

    // Check for symlinks — fail explicitly
    const fileStat = await lstat(absPath);
    if (fileStat.isSymbolicLink()) {
      throw new FingerprintError(
        `Symlinks are not supported: ${posixRel}`,
      );
    }

    if (fileStat.isDirectory()) {
      const children = await enumerateFiles(root, nativeRel);
      result.push(...children);
    } else if (fileStat.isFile()) {
      result.push({ path: posixRel, nativePath: nativeRel });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function prefixedSha256(data: Buffer): string {
  const hash = createHash("sha256").update(data).digest("hex");
  return `sha256:${hash}`;
}

function computeBundleHash(
  files: ReadonlyArray<{ posixPath: string; raw: Buffer; size: number }>,
): string {
  const hasher = createHash("sha256");
  const NUL = Buffer.from([0]);

  for (const f of files) {
    hasher.update(Buffer.from(f.posixPath, "utf-8"));
    hasher.update(NUL);
    hasher.update(Buffer.from(String(f.size), "utf-8"));
    hasher.update(NUL);
    hasher.update(f.raw);
    hasher.update(NUL);
  }

  return `sha256:${hasher.digest("hex")}`;
}

/**
 * Compute the Git blob object SHA-1 for raw file bytes.
 *
 * Reproduces: SHA1("blob " + decimalByteLength + "\0" + rawBytes)
 *
 * This matches `git hash-object <file>` without invoking git.
 */
export function computeGitBlobSha1(data: Buffer): string {
  const header = Buffer.from(`blob ${data.byteLength}\0`, "utf-8");
  const hash = createHash("sha1").update(header).update(data).digest("hex");
  return `sha1:${hash}`;
}

