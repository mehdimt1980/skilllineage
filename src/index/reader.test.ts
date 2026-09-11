import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readManifest,
  readShard,
  readInstructionShard,
  lookupExact,
  lookupInstructions,
  shardPrefix,
  IndexError,
} from "./reader.js";
import type {
  IndexManifest,
  IndexShard,
  InstructionShard,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skilllineage-idx-"));
  tempDirs.push(dir);
  return dir;
}

function validManifest(
  overrides: Partial<Record<string, unknown>> = {},
): IndexManifest {
  return {
    schemaVersion: "0.1",
    kind: "skilllineage-exact-index",
    source: {
      name: "TestSkills",
      snapshot: "2026-01",
      license: "CC-BY-4.0",
      url: "https://example.com",
    },
    indexes: {
      exact: { algorithm: "git-blob-sha1", shardPrefixLength: 2 },
      instructions: {
        algorithm: "normalized-instructions-sha256",
        shardPrefixLength: 2,
      },
    },
    recordCount: 1,
    distinctHashCount: 1,
    instructionIndex: {
      indexedDistinctContentCount: 1,
      skippedDistinctContentCount: 0,
    },
    ...overrides,
  };
}

async function writeManifest(
  dir: string,
  manifest: IndexManifest | Record<string, unknown>,
): Promise<void> {
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

async function writeExactShard(
  dir: string,
  prefix: string,
  data: IndexShard,
): Promise<void> {
  const exactDir = path.join(dir, "exact");
  await mkdir(exactDir, { recursive: true });
  const gz = gzipSync(Buffer.from(JSON.stringify(data, null, 2), "utf-8"));
  await writeFile(path.join(exactDir, `${prefix}.json.gz`), gz);
}

async function writeInstructionShard(
  dir: string,
  prefix: string,
  data: InstructionShard,
): Promise<void> {
  const instrDir = path.join(dir, "instructions");
  await mkdir(instrDir, { recursive: true });
  const gz = gzipSync(Buffer.from(JSON.stringify(data, null, 2), "utf-8"));
  await writeFile(path.join(instrDir, `${prefix}.json.gz`), gz);
}

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// shardPrefix
// ---------------------------------------------------------------------------

describe("shardPrefix", () => {
  it("extracts first 2 hex characters", () => {
    expect(shardPrefix("abcdef1234567890")).toBe("ab");
  });

  it("lowercases the prefix", () => {
    expect(shardPrefix("ABCDEF")).toBe("ab");
  });
});

// ---------------------------------------------------------------------------
// readManifest
// ---------------------------------------------------------------------------

describe("readManifest", () => {
  it("reads a valid manifest", async () => {
    const dir = await makeTempDir();
    const manifest = validManifest();
    await writeManifest(dir, manifest);

    const result = await readManifest(dir);
    expect(result).toEqual(manifest);
  });

  it("fails when manifest is missing", async () => {
    const dir = await makeTempDir();
    await expect(readManifest(dir)).rejects.toThrow(IndexError);
    await expect(readManifest(dir)).rejects.toThrow("Manifest not found");
  });

  it("fails on malformed JSON", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "manifest.json"), "not json{{{");
    await expect(readManifest(dir)).rejects.toThrow("Malformed manifest JSON");
  });

  it("fails on unsupported kind", async () => {
    const dir = await makeTempDir();
    await writeManifest(dir, {
      ...validManifest(),
      kind: "something-else",
    });
    await expect(readManifest(dir)).rejects.toThrow("Unsupported index kind");
  });

  it("fails on unsupported schema version", async () => {
    const dir = await makeTempDir();
    await writeManifest(dir, {
      ...validManifest(),
      schemaVersion: "99.0",
    });
    await expect(readManifest(dir)).rejects.toThrow(
      "Unsupported schema version",
    );
  });

  it("fails on invalid structure (array)", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify([1, 2, 3]),
    );
    await expect(readManifest(dir)).rejects.toThrow("Invalid manifest");
  });
});

// ---------------------------------------------------------------------------
// readShard (exact)
// ---------------------------------------------------------------------------

describe("readShard", () => {
  it("reads and decompresses a valid shard", async () => {
    const dir = await makeTempDir();
    const shardData: IndexShard = {
      ab123: {
        copyCount: 1,
        occurrences: [
          {
            repoFullName: "owner/repo",
            path: "SKILL.md",
            locationClass: "canonical",
            stars: 10,
            firstCommitAt: null,
            lastCommitAt: null,
            historyFetched: null,
          },
        ],
      },
    };
    await writeExactShard(dir, "ab", shardData);

    const result = await readShard(dir, "ab");
    expect(result).toEqual(shardData);
  });

  it("fails when shard is missing", async () => {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, "exact"), { recursive: true });
    await expect(readShard(dir, "zz")).rejects.toThrow("Shard not found");
  });

  it("fails on corrupt gzip", async () => {
    const dir = await makeTempDir();
    const exactDir = path.join(dir, "exact");
    await mkdir(exactDir, { recursive: true });
    await writeFile(
      path.join(exactDir, "ab.json.gz"),
      Buffer.from("not gzip data"),
    );
    await expect(readShard(dir, "ab")).rejects.toThrow("Corrupt gzip");
  });

  it("empty shard {} is valid and returns empty object", async () => {
    const dir = await makeTempDir();
    await writeExactShard(dir, "00", {});
    const result = await readShard(dir, "00");
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// lookupExact
// ---------------------------------------------------------------------------

describe("lookupExact", () => {
  it("finds an exact hash match", async () => {
    const dir = await makeTempDir();
    const hash = "ab12345678901234567890123456789012345678";
    await writeExactShard(dir, "ab", {
      [hash]: {
        copyCount: 1,
        occurrences: [
          {
            repoFullName: "owner/repo",
            path: "SKILL.md",
            locationClass: null,
            stars: 5,
            firstCommitAt: null,
            lastCommitAt: null,
            historyFetched: null,
          },
        ],
      },
    });

    const result = await lookupExact(dir, hash);
    expect(result).not.toBeNull();
    expect(result?.copyCount).toBe(1);
  });

  it("returns null for unknown hash in existing shard", async () => {
    const dir = await makeTempDir();
    await writeExactShard(dir, "ab", {
      ab00000000000000000000000000000000000000: {
        copyCount: 1,
        occurrences: [],
      },
    });

    const result = await lookupExact(
      dir,
      "ab99999999999999999999999999999999999999",
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readInstructionShard / lookupInstructions
// ---------------------------------------------------------------------------

describe("readInstructionShard", () => {
  it("reads a valid instruction shard", async () => {
    const dir = await makeTempDir();
    const data: InstructionShard = {
      ba882dcc1234567890abcdef1234567890abcdef1234567890abcdef12345678: [
        "ab12345678901234567890123456789012345678",
      ],
    };
    await writeInstructionShard(dir, "ba", data);

    const result = await readInstructionShard(dir, "ba");
    expect(result).toEqual(data);
  });

  it("empty instruction shard {} is valid", async () => {
    const dir = await makeTempDir();
    await writeInstructionShard(dir, "00", {});
    const result = await readInstructionShard(dir, "00");
    expect(result).toEqual({});
  });
});

describe("lookupInstructions", () => {
  it("returns blob hashes for known instruction hash", async () => {
    const dir = await makeTempDir();
    const instrHash =
      "ba882dcc1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    const blobHash = "ab12345678901234567890123456789012345678";

    await writeInstructionShard(dir, "ba", {
      [instrHash]: [blobHash],
    });

    const result = await lookupInstructions(dir, instrHash);
    expect(result).toEqual([blobHash]);
  });

  it("returns null for unknown instruction hash in existing shard", async () => {
    const dir = await makeTempDir();
    await writeInstructionShard(dir, "ba", {
      ba00000000000000000000000000000000000000000000000000000000000000: [],
    });
    const result = await lookupInstructions(
      dir,
      "ba99999999999999999999999999999999999999999999999999999999999999",
    );
    expect(result).toBeNull();
  });
});
