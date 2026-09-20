import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readManifest,
  readShard,
  readInstructionShard,
  readSketchShard,
  readVariantEnrichmentShard,
  lookupExact,
  lookupInstructions,
  shardPrefix,
  IndexError,
  lookupExactHistory,
  lookupInstructionHistory,
  readHistoryShard,
} from "./reader.js";
import type {
  IndexManifest,
  IndexShard,
  InstructionShard,
  SketchShard,
  VariantEnrichmentShard,
} from "./types.js";

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
    schemaVersion: "0.5",
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
    variantIndex: {
      algorithm: "bottom-k-token-shingles-v1",
      shingleSize: 5,
      shingleHash: "sha256-96",
      sketchSize: 32,
      anchorCount: 8,
      maxAnchorPostings: 2000,
      anchorShardRouting: "sha256-anchor-hex-v1",
      sketchShardRouting: "variant-id-hex4-v1",
      enrichment: {
        algorithm: "precomputed-variant-summary-v1",
        shardRouting: "instructions-sha256-hex4-v1",
        exampleLimit: 3,
      },
      skippedHotAnchorCount: 0,
    },
    historyIndex: {
      algorithm: "dataset-observed-history-v1",
      exactRouting: "git-blob-sha1-hex4-v1",
      instructionRouting: "instructions-sha256-hex4-v1",
      semantics: "observed-not-origin",
      timestampNormalization: "utc-v1",
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

async function writeSketchShard(
  dir: string,
  routeKey: string,
  data: SketchShard,
): Promise<void> {
  const [first, second] = routeKey.split("/");
  const sketchDir = path.join(dir, "variants", "sketches", first);
  await mkdir(sketchDir, { recursive: true });
  const gz = gzipSync(Buffer.from(JSON.stringify(data, null, 2), "utf-8"));
  await writeFile(path.join(sketchDir, `${second}.json.gz`), gz);
}

async function writeEnrichmentShard(
  dir: string,
  routeKey: string,
  data: VariantEnrichmentShard,
): Promise<void> {
  const [first, second] = routeKey.split("/");
  const enrichmentDir = path.join(dir, "variants", "enrichment", first);
  await mkdir(enrichmentDir, { recursive: true });
  const gz = gzipSync(Buffer.from(JSON.stringify(data, null, 2), "utf-8"));
  await writeFile(path.join(enrichmentDir, `${second}.json.gz`), gz);
}

beforeEach(() => {
  tempDirs = [];
});

describe("sparse history reader", () => {
  const exactHash = "a1b2" + "a".repeat(36);
  const instructionHash = "a1b2" + "b".repeat(60);

  it("returns null when no historical shard exists", async () => {
    const dir = await makeTempDir();
    expect(await lookupExactHistory(dir, exactHash)).toBeNull();
    expect(await lookupInstructionHistory(dir, instructionHash)).toBeNull();
  });

  it("reads a valid summary and rejects malformed existing shards", async () => {
    const dir = await makeTempDir();
    const folder = path.join(dir, "history", "exact", "a1");
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, "b2.json.gz");
    const summary = {
      totalLocationCount: 1, historyFetchedLocationCount: 1,
      usableLocationCount: 0, chronologyAnomalyCount: 0,
      conflictingLocationCount: 0, coverage: "none",
      earliestObserved: null, latestObserved: null,
    };
    await writeFile(file, gzipSync(Buffer.from(JSON.stringify({ [exactHash]: summary }))));
    const events: import("./reader.js").ShardReadEvent[] = [];
    expect(await lookupExactHistory(dir, exactHash.toUpperCase(), (event) => events.push(event))).toEqual(summary);
    expect(events).toMatchObject([{ shardKind: "history_exact", prefix: "a1/b2" }]);
    await writeFile(file, gzipSync(Buffer.from(JSON.stringify({ [exactHash]: { ...summary, coverage: "complete" } }))));
    await expect(readHistoryShard(dir, "exact", "a1/b2")).rejects.toThrow("Invalid history summary");
    await writeFile(file, gzipSync(Buffer.from("not-json")));
    await expect(lookupExactHistory(dir, exactHash)).rejects.toThrow("Malformed shard JSON");
  });

  it("rejects impossible counts and non-canonical historical observations", async () => {
    const dir = await makeTempDir();
    const folder = path.join(dir, "history", "exact", "a1");
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, "b2.json.gz");
    const observation = {
      repoFullName: "owner/repo",
      path: "SKILL.md",
      firstCommitAt: "2026-01-01T00:00:00.000000Z",
      lastCommitAt: "2026-01-02T00:00:00.000000Z",
    };
    const valid = {
      totalLocationCount: 2,
      historyFetchedLocationCount: 2,
      usableLocationCount: 2,
      chronologyAnomalyCount: 0,
      conflictingLocationCount: 0,
      coverage: "complete",
      earliestObserved: observation,
      latestObserved: observation,
    };

    const invalidRecords = [
      { ...valid, chronologyAnomalyCount: 1 },
      { ...valid, conflictingLocationCount: 1 },
      {
        ...valid,
        earliestObserved: {
          ...observation,
          firstCommitAt: "2026-01-01T01:00:00+01:00",
        },
      },
      {
        ...valid,
        earliestObserved: {
          ...observation,
          lastCommitAt: "2025-12-31T23:59:59.000000Z",
        },
      },
      {
        ...valid,
        earliestObserved: {
          ...observation,
          firstCommitAt: "2026-02-01T00:00:00.000000Z",
          lastCommitAt: null,
        },
        latestObserved: {
          ...observation,
          firstCommitAt: "2026-01-01T00:00:00.000000Z",
          lastCommitAt: null,
        },
      },
      {
        ...valid,
        totalLocationCount: 3,
        usableLocationCount: 2,
        chronologyAnomalyCount: 2,
        coverage: "partial",
      },
    ];

    for (const record of invalidRecords) {
      await writeFile(
        file,
        gzipSync(Buffer.from(JSON.stringify({ [exactHash]: record }))),
      );
      await expect(readHistoryShard(dir, "exact", "a1/b2")).rejects.toThrow(
        "Invalid history summary",
      );
    }
  });
});

afterEach(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true });
  }
});

describe("shardPrefix", () => {
  it("extracts first 2 hex characters", () => {
    expect(shardPrefix("abcdef1234567890")).toBe("ab");
  });

  it("lowercases the prefix", () => {
    expect(shardPrefix("ABCDEF")).toBe("ab");
  });
});

describe("readManifest", () => {
  it("reads a valid schema-0.5 manifest", async () => {
    const dir = await makeTempDir();
    const manifest = validManifest();
    await writeManifest(dir, manifest);
    expect(await readManifest(dir)).toEqual(manifest);
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
    await writeManifest(dir, { ...validManifest(), kind: "something-else" });
    await expect(readManifest(dir)).rejects.toThrow("Unsupported index kind");
  });

  it("rejects schema 0.3 with an explicit rebuild instruction", async () => {
    const dir = await makeTempDir();
    await writeManifest(dir, { ...validManifest(), schemaVersion: "0.3" });
    await expect(readManifest(dir)).rejects.toThrow(
      "Unsupported schema version: 0.3",
    );
    await expect(readManifest(dir)).rejects.toThrow("Rebuild the index");
  });

  it("fails on invalid structure (array)", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify([1, 2, 3]));
    await expect(readManifest(dir)).rejects.toThrow("Invalid manifest");
  });

  it("rejects incompatible variant-index parameters", async () => {
    const dir = await makeTempDir();
    await writeManifest(dir, {
      ...validManifest(),
      variantIndex: { ...validManifest().variantIndex, sketchSize: 64 },
    });
    await expect(readManifest(dir)).rejects.toThrow(
      "Unsupported variant index parameters",
    );
  });

  it("requires anchor, sketch, and enrichment routing declarations", async () => {
    const dir = await makeTempDir();
    await writeManifest(dir, {
      ...validManifest(),
      variantIndex: {
        ...validManifest().variantIndex,
        anchorShardRouting: undefined,
      },
    });
    await expect(readManifest(dir)).rejects.toThrow("Rebuild the index");
    await writeManifest(dir, {
      ...validManifest(),
      variantIndex: {
        ...validManifest().variantIndex,
        sketchShardRouting: undefined,
      },
    });
    await expect(readManifest(dir)).rejects.toThrow("Rebuild the index");
    await writeManifest(dir, {
      ...validManifest(),
      variantIndex: { ...validManifest().variantIndex, enrichment: undefined },
    });
    await expect(readManifest(dir)).rejects.toThrow("Rebuild the index");
  });
});

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
    expect(await readShard(dir, "ab")).toEqual(shardData);
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
    expect(await readShard(dir, "00")).toEqual({});
  });
});

describe("shard read profiling", () => {
  it("observes bytes and non-negative timings without changing parsed data", async () => {
    const dir = await makeTempDir();
    await writeExactShard(dir, "ab", {
      abcd: { copyCount: 0, occurrences: [] },
    });
    const events: import("./reader.js").ShardReadEvent[] = [];
    expect(
      await readShard(dir, "ab", (event) => events.push(event)),
    ).toEqual(await readShard(dir, "ab"));
    expect(events).toHaveLength(1);
    expect(events[0].shardKind).toBe("exact");
    expect(events[0].compressedBytes).toBeGreaterThan(0);
    expect(events[0].decompressedBytes).toBeGreaterThan(0);
    expect(events[0].readMs).toBeGreaterThanOrEqual(0);
    expect(events[0].gunzipMs).toBeGreaterThanOrEqual(0);
    expect(events[0].parseMs).toBeGreaterThanOrEqual(0);
  });
});

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
    expect((await lookupExact(dir, hash))?.copyCount).toBe(1);
  });

  it("returns null for unknown hash in existing shard", async () => {
    const dir = await makeTempDir();
    await writeExactShard(dir, "ab", {
      ab00000000000000000000000000000000000000: {
        copyCount: 1,
        occurrences: [],
      },
    });
    expect(
      await lookupExact(dir, "ab99999999999999999999999999999999999999"),
    ).toBeNull();
  });
});

describe("readInstructionShard", () => {
  it("reads a valid instruction shard", async () => {
    const dir = await makeTempDir();
    const data: InstructionShard = {
      ba882dcc1234567890abcdef1234567890abcdef1234567890abcdef12345678: [
        "ab12345678901234567890123456789012345678",
      ],
    };
    await writeInstructionShard(dir, "ba", data);
    expect(await readInstructionShard(dir, "ba")).toEqual(data);
  });

  it("empty instruction shard {} is valid", async () => {
    const dir = await makeTempDir();
    await writeInstructionShard(dir, "00", {});
    expect(await readInstructionShard(dir, "00")).toEqual({});
  });
});

describe("lookupInstructions", () => {
  it("returns blob hashes for known instruction hash", async () => {
    const dir = await makeTempDir();
    const instrHash =
      "ba882dcc1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    const blobHash = "ab12345678901234567890123456789012345678";
    await writeInstructionShard(dir, "ba", { [instrHash]: [blobHash] });
    expect(await lookupInstructions(dir, instrHash)).toEqual([blobHash]);
  });

  it("returns null for unknown instruction hash in existing shard", async () => {
    const dir = await makeTempDir();
    await writeInstructionShard(dir, "ba", {
      ba00000000000000000000000000000000000000000000000000000000000000: [],
    });
    expect(
      await lookupInstructions(
        dir,
        "ba99999999999999999999999999999999999999999999999999999999999999",
      ),
    ).toBeNull();
  });
});

describe("readSketchShard", () => {
  it("reads a nested sketch micro-shard and reports its stable route key", async () => {
    const dir = await makeTempDir();
    const variantId = "a1b2" + "0".repeat(20);
    const data: SketchShard = {
      [variantId]: {
        instructionsSha256: "f".repeat(64),
        sketch: ["01", "02"],
      },
    };
    await writeSketchShard(dir, "a1/b2", data);
    const events: import("./reader.js").ShardReadEvent[] = [];
    expect(
      await readSketchShard(dir, "A1/B2", (event) => events.push(event)),
    ).toEqual(data);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      shardKind: "variant_sketch",
      prefix: "a1/b2",
    });
  });

  it("treats a missing sketch micro-shard as empty without weakening exact reads", async () => {
    const dir = await makeTempDir();
    expect(await readSketchShard(dir, "a1/b2")).toEqual({});
    await expect(readShard(dir, "a1")).rejects.toThrow("Shard not found");
  });

  it("fails for a malformed existing sketch micro-shard", async () => {
    const dir = await makeTempDir();
    const sketchDir = path.join(dir, "variants", "sketches", "a1");
    await mkdir(sketchDir, { recursive: true });
    await writeFile(
      path.join(sketchDir, "b2.json.gz"),
      Buffer.from("not gzip data"),
    );
    await expect(readSketchShard(dir, "a1/b2")).rejects.toThrow(
      "Corrupt gzip",
    );
  });

  it("rejects unsafe or malformed sketch routes", async () => {
    const dir = await makeTempDir();
    await expect(readSketchShard(dir, "../../etc")).rejects.toThrow(
      "Invalid variant sketch route",
    );
  });
});

describe("readVariantEnrichmentShard", () => {
  const hash = "a1b2" + "f".repeat(60);
  const valid: VariantEnrichmentShard = {
    [hash]: {
      rawVariantCount: 2,
      copyCount: 3,
      examples: [
        { repoFullName: "a/repo", path: "SKILL.md", stars: 10 },
        { repoFullName: "b/repo", path: "SKILL.md", stars: null },
      ],
    },
  };

  it("reads and profiles a valid enrichment summary shard", async () => {
    const dir = await makeTempDir();
    await writeEnrichmentShard(dir, "a1/b2", valid);
    const events: import("./reader.js").ShardReadEvent[] = [];
    expect(
      await readVariantEnrichmentShard(dir, "A1/B2", (event) =>
        events.push(event),
      ),
    ).toEqual(valid);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      shardKind: "variant_enrichment",
      prefix: "a1/b2",
    });
  });

  it("treats a missing enrichment shard as index inconsistency", async () => {
    const dir = await makeTempDir();
    await expect(readVariantEnrichmentShard(dir, "a1/b2")).rejects.toThrow(
      "Variant enrichment index is inconsistent",
    );
    await expect(readVariantEnrichmentShard(dir, "a1/b2")).rejects.toThrow(
      "Rebuild the index",
    );
  });

  it("rejects corrupt gzip and malformed JSON with rebuild guidance", async () => {
    const dir = await makeTempDir();
    const enrichmentDir = path.join(dir, "variants", "enrichment", "a1");
    await mkdir(enrichmentDir, { recursive: true });
    await writeFile(
      path.join(enrichmentDir, "b2.json.gz"),
      Buffer.from("not gzip data"),
    );
    await expect(readVariantEnrichmentShard(dir, "a1/b2")).rejects.toThrow(
      "Rebuild the index",
    );

    await writeFile(
      path.join(enrichmentDir, "b2.json.gz"),
      gzipSync(Buffer.from("not-json", "utf-8")),
    );
    await expect(readVariantEnrichmentShard(dir, "a1/b2")).rejects.toThrow(
      "Rebuild the index",
    );
  });

  it("rejects structurally invalid summary records", async () => {
    const dir = await makeTempDir();
    const enrichmentDir = path.join(dir, "variants", "enrichment", "a1");
    await mkdir(enrichmentDir, { recursive: true });
    const invalid = {
      [hash]: {
        rawVariantCount: 0,
        copyCount: 1,
        examples: [],
      },
    };
    await writeFile(
      path.join(enrichmentDir, "b2.json.gz"),
      gzipSync(Buffer.from(JSON.stringify(invalid), "utf-8")),
    );
    await expect(readVariantEnrichmentShard(dir, "a1/b2")).rejects.toThrow(
      "invalid summary structure",
    );
  });

  it("rejects unsafe or malformed enrichment routes", async () => {
    const dir = await makeTempDir();
    await expect(
      readVariantEnrichmentShard(dir, "../../etc"),
    ).rejects.toThrow("Invalid variant enrichment route");
  });
});
