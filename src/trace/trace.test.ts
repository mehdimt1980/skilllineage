import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";

import { traceSkill, TraceError, buildSameInstructionsMatch } from "./trace.js";
import { computeGitBlobSha1, normalizeInstructions } from "../fingerprint/index.js";
import type {
  IndexManifest,
  IndexShard,
  InstructionShard,
  SketchShard,
  AnchorShard,
} from "../index/types.js";
import { variantSketchRoute } from "../index/routing.js";
import {
  anchorShardPrefix,
  instructionSketch,
  variantIdFromInstructionsSha256,
} from "../variant/index.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skilllineage-trace-"));
  tempDirs.push(dir);
  return dir;
}

async function makeTempSkill(files: Record<string, string>): Promise<string> {
  const dir = await makeTempDir();
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return dir;
}

function validManifest(): IndexManifest {
  return {
    schemaVersion: "0.3",
    kind: "skilllineage-exact-index",
    source: {
      name: "TestSkills",
      snapshot: "2026-01",
      license: "CC-BY-4.0",
      url: "https://example.com",
    },
    indexes: {
      exact: { algorithm: "git-blob-sha1", shardPrefixLength: 2 },
      instructions: { algorithm: "normalized-instructions-sha256", shardPrefixLength: 2 },
    },
    recordCount: 1,
    distinctHashCount: 1,
    instructionIndex: { indexedDistinctContentCount: 1, skippedDistinctContentCount: 0 },
    variantIndex: {
      algorithm: "bottom-k-token-shingles-v1",
      shingleSize: 5,
      shingleHash: "sha256-96",
      sketchSize: 32,
      anchorCount: 8,
      maxAnchorPostings: 2000,
      anchorShardRouting: "sha256-anchor-hex-v1",
      sketchShardRouting: "variant-id-hex4-v1",
      skippedHotAnchorCount: 0,
    },
  };
}

function instrHex(content: string): string {
  return createHash("sha256")
    .update(Buffer.from(normalizeInstructions(content), "utf-8"))
    .digest("hex");
}

interface TestIndex {
  exactShards?: Record<string, IndexShard>;
  instrShards?: Record<string, InstructionShard>;
  sketchShards?: Record<string, SketchShard>;
  anchorShards?: Record<string, AnchorShard>;
  manifest?: IndexManifest;
}

async function writeGzip(filePath: string, data: object): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, gzipSync(Buffer.from(JSON.stringify(data), "utf-8")));
}

async function makeIndex(opts: TestIndex = {}): Promise<string> {
  const dir = await makeTempDir();
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(opts.manifest ?? validManifest()), "utf-8");

  for (let i = 0; i < 256; i++) {
    const pfx = i.toString(16).padStart(2, "0");
    await writeGzip(path.join(dir, "exact", `${pfx}.json.gz`), opts.exactShards?.[pfx] ?? {});
    await writeGzip(path.join(dir, "instructions", `${pfx}.json.gz`), opts.instrShards?.[pfx] ?? {});
    await writeGzip(path.join(dir, "variants", "anchors", `${pfx}.json.gz`), opts.anchorShards?.[pfx] ?? {});
  }

  for (const [routeKey, shard] of Object.entries(opts.sketchShards ?? {})) {
    const [first, second] = routeKey.split("/");
    await writeGzip(path.join(dir, "variants", "sketches", first, `${second}.json.gz`), shard);
  }

  return dir;
}

const TOOL_VERSION = "0.1.0";
const OCCURRENCE_A = {
  repoFullName: "alice/skills",
  path: ".claude/skills/useful/SKILL.md",
  locationClass: "canonical",
  stars: 100,
  firstCommitAt: "2026-01-10T12:00:00Z",
  lastCommitAt: "2026-04-11T10:00:00Z",
  historyFetched: true as boolean | null,
};
const OCCURRENCE_B = {
  repoFullName: "bob/skills",
  path: "skills/SKILL.md",
  locationClass: null,
  stars: 5,
  firstCommitAt: null,
  lastCommitAt: null,
  historyFetched: false as boolean | null,
};

beforeEach(() => { tempDirs = []; });
afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe("trace precedence and profiling", () => {
  it("returns an exact match before lower-precedence evidence", async () => {
    const content = "---\nname: local\n---\n# Skill\nDo the thing.\n";
    const skillDir = await makeTempSkill({ "SKILL.md": content });
    const blobHash = computeGitBlobSha1(Buffer.from(content)).replace(/^sha1:/, "");
    const instructionHash = instrHex(content);
    const indexDir = await makeIndex({
      exactShards: { [blobHash.slice(0, 2)]: { [blobHash]: { copyCount: 1, occurrences: [OCCURRENCE_A] } } },
      instrShards: { [instructionHash.slice(0, 2)]: { [instructionHash]: [blobHash] } },
    });
    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);
    expect(report.match.type).toBe("exact");
    expect(report.origin.status).toBe("not_inferred");
  });

  it("collects optional profiling without exposing it in the trace report", async () => {
    const content = "# Skill\nprofile this exact case\n";
    const skillDir = await makeTempSkill({ "SKILL.md": content });
    const blobHash = computeGitBlobSha1(Buffer.from(content)).replace(/^sha1:/, "");
    const indexDir = await makeIndex({ exactShards: { [blobHash.slice(0, 2)]: { [blobHash]: { copyCount: 1, occurrences: [OCCURRENCE_A] } } } });
    const profile: import("./types.js").TraceProfiling = { stages: {}, counts: {}, shardReads: [] };
    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION, { profile });
    expect(report.match.type).toBe("exact");
    expect("profiling" in report).toBe(false);
    expect(profile.stages.exactLookupMs).toBeGreaterThanOrEqual(0);
    expect(profile.shardReads[0]?.shardKind).toBe("exact");
  });

  it("resolves frontmatter-only variants as same_instructions", async () => {
    const indexed = "---\nname: indexed\n---\n# Skill\nDo the thing.\n";
    const local = "---\nname: local\n---\n# Skill\nDo the thing.\n";
    const skillDir = await makeTempSkill({ "SKILL.md": local });
    const blobHash = computeGitBlobSha1(Buffer.from(indexed)).replace(/^sha1:/, "");
    const instructionHash = instrHex(indexed);
    const indexDir = await makeIndex({
      exactShards: { [blobHash.slice(0, 2)]: { [blobHash]: { copyCount: 1, occurrences: [OCCURRENCE_A] } } },
      instrShards: { [instructionHash.slice(0, 2)]: { [instructionHash]: [blobHash] } },
    });
    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);
    expect(report.match.type).toBe("same_instructions");
  });

  it("retrieves a variant from the schema-0.3 sketch micro-shard", async () => {
    const indexed = "one two three four five six seven eight nine ten eleven twelve\n";
    const local = `${indexed.trim()} benchmark mutation\n`;
    const skillDir = await makeTempSkill({ "SKILL.md": local });
    const fullInstructionHash = instrHex(indexed);
    const variantId = variantIdFromInstructionsSha256(fullInstructionHash);
    const candidateSketch = instructionSketch(normalizeInstructions(indexed));
    const localSketch = instructionSketch(normalizeInstructions(local));
    const anchorShards: Record<string, AnchorShard> = {};
    for (const anchor of localSketch.slice(0, 8)) {
      if (!candidateSketch.includes(anchor)) continue;
      const prefix = anchorShardPrefix(anchor);
      (anchorShards[prefix] ??= {})[anchor] = [variantId];
    }
    const routeKey = variantSketchRoute(variantId).key;
    const indexedBlob = "aa" + "0".repeat(38);
    const indexDir = await makeIndex({
      exactShards: { aa: { [indexedBlob]: { copyCount: 1, occurrences: [OCCURRENCE_A] } } },
      instrShards: { [fullInstructionHash.slice(0, 2)]: { [fullInstructionHash]: [indexedBlob] } },
      sketchShards: { [routeKey]: { [variantId]: { instructionsSha256: fullInstructionHash, sketch: candidateSketch } } },
      anchorShards,
    });
    const profile: import("./types.js").TraceProfiling = { stages: {}, counts: {}, shardReads: [] };
    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION, { profile });
    expect(report.match.type).toBe("variant_candidates");
    if (report.match.type === "variant_candidates") {
      expect(report.match.candidates[0]?.instructionsSha256).toBe(`sha256:${fullInstructionHash}`);
    }
    const sketchEvents = profile.shardReads.filter((event) => event.shardKind === "variant_sketch");
    expect(sketchEvents.some((event) => event.prefix === routeKey)).toBe(true);
  });

  it("returns none for unrelated content", async () => {
    const skillDir = await makeTempSkill({ "SKILL.md": "orbital marine crystal\n" });
    const report = await traceSkill(skillDir, await makeIndex(), TOOL_VERSION);
    expect(report.match.type).toBe("none");
  });
});

describe("buildSameInstructionsMatch", () => {
  it("deduplicates occurrences and sorts content hashes", async () => {
    const hashes = ["bb" + "1".repeat(38), "aa" + "2".repeat(38)];
    const shards: Record<string, IndexShard> = {
      aa: { [hashes[1]]: { copyCount: 1, occurrences: [OCCURRENCE_A] } },
      bb: { [hashes[0]]: { copyCount: 1, occurrences: [OCCURRENCE_B] } },
    };
    const result = await buildSameInstructionsMatch("unused", hashes, (_dir, prefix) => Promise.resolve(shards[prefix] ?? {}));
    expect(result.rawVariantCount).toBe(2);
    expect(result.contentHashes).toEqual([...hashes].sort().map((hash) => `sha1:${hash}`));
    expect(result.copyCount).toBe(2);
  });
});

describe("trace validation", () => {
  it("rejects a missing index directory", async () => {
    const skillDir = await makeTempSkill({ "SKILL.md": "# Skill\n" });
    await expect(traceSkill(skillDir, path.join(skillDir, "missing"), TOOL_VERSION)).rejects.toThrow(TraceError);
  });
});
