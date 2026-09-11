import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";

import { traceSkill, TraceError, buildSameInstructionsMatch } from "./trace.js";
import { computeGitBlobSha1 } from "../fingerprint/index.js";
import { normalizeInstructions } from "../fingerprint/index.js";
import { IndexError } from "../index/index.js";
import { FingerprintError } from "../fingerprint/index.js";
import type {
  IndexManifest,
  IndexShard,
  InstructionShard,
  SketchShard,
  AnchorShard,
} from "../index/types.js";
import { instructionSketch, variantIdFromInstructionsSha256 } from "../variant/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skilllineage-trace-"));
  tempDirs.push(dir);
  return dir;
}

async function makeTempSkill(
  files: Record<string, string>,
): Promise<string> {
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
    variantIndex: {
      algorithm: "bottom-k-token-shingles-v1",
      shingleSize: 5,
      shingleHash: "sha256-96",
      sketchSize: 32,
      anchorCount: 8,
      maxAnchorPostings: 2000,
      skippedHotAnchorCount: 0,
    },
  };
}

function instrHex(content: string): string {
  const normalized = normalizeInstructions(content);
  return createHash("sha256").update(Buffer.from(normalized, "utf-8")).digest("hex");
}

interface TestIndex {
  exactShards?: Record<string, IndexShard>;
  instrShards?: Record<string, InstructionShard>;
  sketchShards?: Record<string, SketchShard>;
  anchorShards?: Record<string, AnchorShard>;
  manifest?: IndexManifest;
}

async function makeIndex(opts: TestIndex = {}): Promise<string> {
  const dir = await makeTempDir();
  const m = opts.manifest ?? validManifest();
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(m, null, 2),
    "utf-8",
  );

  const exactDir = path.join(dir, "exact");
  const instrDir = path.join(dir, "instructions");
  const sketchDir = path.join(dir, "variants", "sketches");
  const anchorDir = path.join(dir, "variants", "anchors");
  await mkdir(exactDir, { recursive: true });
  await mkdir(instrDir, { recursive: true });
  await mkdir(sketchDir, { recursive: true });
  await mkdir(anchorDir, { recursive: true });

  // Write all 256 exact shards (empty by default, override with exactShards)
  for (let i = 0; i < 256; i++) {
    const pfx = i.toString(16).padStart(2, "0");
    const data = opts.exactShards?.[pfx] ?? {};
    const gz = gzipSync(Buffer.from(JSON.stringify(data, null, 2), "utf-8"));
    await writeFile(path.join(exactDir, `${pfx}.json.gz`), gz);
  }

  // Write all 256 instruction shards (empty by default)
  for (let i = 0; i < 256; i++) {
    const pfx = i.toString(16).padStart(2, "0");
    const data = opts.instrShards?.[pfx] ?? {};
    const gz = gzipSync(Buffer.from(JSON.stringify(data, null, 2), "utf-8"));
    await writeFile(path.join(instrDir, `${pfx}.json.gz`), gz);
    const sketchGz = gzipSync(Buffer.from(JSON.stringify(opts.sketchShards?.[pfx] ?? {}), "utf-8"));
    const anchorGz = gzipSync(Buffer.from(JSON.stringify(opts.anchorShards?.[pfx] ?? {}), "utf-8"));
    await writeFile(path.join(sketchDir, `${pfx}.json.gz`), sketchGz);
    await writeFile(path.join(anchorDir, `${pfx}.json.gz`), anchorGz);
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

const OCCURRENCE_C = {
  ...OCCURRENCE_B,
  repoFullName: "carol/skills",
  path: "agents/content/SKILL.md",
};

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Exact match
// ---------------------------------------------------------------------------

describe("exact match", () => {
  it("finds an exact match and returns correct report", async () => {
    const skillContent = "# My Skill\n\nDo something useful.\n";
    const skillDir = await makeTempSkill({ "SKILL.md": skillContent });

    const blobHash = computeGitBlobSha1(
      Buffer.from(skillContent, "utf-8"),
    ).replace(/^sha1:/, "");
    const prefix = blobHash.slice(0, 2);

    const indexDir = await makeIndex({
      exactShards: {
        [prefix]: {
          [blobHash]: { copyCount: 2, occurrences: [OCCURRENCE_A, OCCURRENCE_B] },
        },
      },
    });

    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

    expect(report.schemaVersion).toBe("0.1");
    expect(report.query.gitBlobSha1).toBe(`sha1:${blobHash}`);
    expect(report.match.type).toBe("exact");
    if (report.match.type === "exact") {
      expect(report.match.copyCount).toBe(2);
      expect(report.match.occurrences).toHaveLength(2);
    }
    expect(report.origin.status).toBe("not_inferred");
  });

  it("exact match takes precedence over same_instructions", async () => {
    // Skill with frontmatter — raw sha1 and instruction sha both have matches
    const skillContent = "---\nname: test\n---\n# Skill\n\nDo the thing.\n";
    const skillDir = await makeTempSkill({ "SKILL.md": skillContent });

    const blobHash = computeGitBlobSha1(
      Buffer.from(skillContent, "utf-8"),
    ).replace(/^sha1:/, "");
    const blobPrefix = blobHash.slice(0, 2);

    const instrHash = instrHex(skillContent);
    const instrPrefix = instrHash.slice(0, 2);

    // Populate BOTH exact and instruction indexes
    const indexDir = await makeIndex({
      exactShards: {
        [blobPrefix]: {
          [blobHash]: { copyCount: 1, occurrences: [OCCURRENCE_A] },
        },
      },
      instrShards: {
        [instrPrefix]: {
          [instrHash]: [blobHash],
        },
      },
    });

    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

    // Must be exact, not same_instructions
    expect(report.match.type).toBe("exact");
  });

  it("report includes both query fingerprints", async () => {
    const skillContent = "# Skill\n";
    const skillDir = await makeTempSkill({ "SKILL.md": skillContent });

    const indexDir = await makeIndex({});
    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

    expect(report.query.gitBlobSha1).toMatch(/^sha1:[a-f0-9]{40}$/);
    expect(report.query.instructionsSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// same_instructions match
// ---------------------------------------------------------------------------

describe("same_instructions match", () => {
  it("frontmatter-only variants resolve as same_instructions", async () => {
    // Indexed and local SKILL.md variants have different frontmatter but the same body.
    const bodyA = "---\nname: skill-a\n---\n# Skill\n\nDo the thing.\n";
    const bodyB = "---\nname: skill-b\n---\n# Skill\n\nDo the thing.\n";
    const bodyC = "---\nname: local-only\n---\n# Skill\n\nDo the thing.\n";

    const skillDir = await makeTempSkill({ "SKILL.md": bodyC });

    const blobHashA = computeGitBlobSha1(
      Buffer.from(bodyA, "utf-8"),
    ).replace(/^sha1:/, "");
    const blobHashB = computeGitBlobSha1(
      Buffer.from(bodyB, "utf-8"),
    ).replace(/^sha1:/, "");
    const instrHash = instrHex(bodyA); // same as instrHex(bodyB)

    const instrPrefix = instrHash.slice(0, 2);
    const prefixA = blobHashA.slice(0, 2);
    const prefixB = blobHashB.slice(0, 2);

    const exactShards: Record<string, IndexShard> = {
      [prefixA]: {
        [blobHashA]: { copyCount: 1, occurrences: [OCCURRENCE_A] },
      },
    };

    if (prefixB === prefixA) {
      exactShards[prefixA][blobHashB] = {
        copyCount: 1,
        occurrences: [OCCURRENCE_B],
      };
    } else {
      exactShards[prefixB] = {
        [blobHashB]: { copyCount: 1, occurrences: [OCCURRENCE_B] },
      };
    }

    const instrShards: Record<string, InstructionShard> = {
      [instrPrefix]: { [instrHash]: [blobHashA, blobHashB].sort() },
    };

    const indexDir = await makeIndex({ exactShards, instrShards });

    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

    expect(report.match.type).toBe("same_instructions");
    if (report.match.type === "same_instructions") {
      expect(report.match.rawVariantCount).toBe(2);
      expect(report.match.contentHashes).toHaveLength(2);
      expect(report.match.contentHashes[0]).toMatch(/^sha1:/);
    }
  });

  it("CRLF/LF variant resolves as same_instructions", async () => {
    const bodyLF = "# Skill\n\nDo something.\n";
    const bodyCRLF = "# Skill\r\n\r\nDo something.\r\n";

    // Local skill has CRLF
    const skillDir = await makeTempSkill({ "SKILL.md": bodyCRLF });

    const blobHashLF = computeGitBlobSha1(
      Buffer.from(bodyLF, "utf-8"),
    ).replace(/^sha1:/, "");
    const blobHashCRLF = computeGitBlobSha1(
      Buffer.from(bodyCRLF, "utf-8"),
    ).replace(/^sha1:/, "");
    const instrHash = instrHex(bodyLF); // same as instrHex(bodyCRLF)
    const instrPrefix = instrHash.slice(0, 2);
    const prefixLF = blobHashLF.slice(0, 2);

    const exactShards: Record<string, IndexShard> = {
      [prefixLF]: {
        [blobHashLF]: { copyCount: 1, occurrences: [OCCURRENCE_A] },
      },
    };

    const instrShards: Record<string, InstructionShard> = {
      [instrPrefix]: {
        [instrHash]: [blobHashLF, blobHashCRLF].sort(),
      },
    };

    const indexDir = await makeIndex({ exactShards, instrShards });
    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

    expect(report.match.type).toBe("same_instructions");
  });

  it("copyCount aggregates occurrences across raw variants", async () => {
    const bodyA = "# Skill\n\nContent.\n";
    const bodyB = "---\nname: x\n---\n# Skill\n\nContent.\n";
    const skillDir = await makeTempSkill({ "SKILL.md": bodyB });

    const blobA = computeGitBlobSha1(
      Buffer.from(bodyA, "utf-8"),
    ).replace(/^sha1:/, "");
    const blobB = computeGitBlobSha1(
      Buffer.from(bodyB, "utf-8"),
    ).replace(/^sha1:/, "");
    const instrHash = instrHex(bodyA);
    const instrPrefix = instrHash.slice(0, 2);

    const exactShards: Record<string, IndexShard> = {
      [blobA.slice(0, 2)]: {
        [blobA]: {
          copyCount: 3,
          occurrences: [OCCURRENCE_C, OCCURRENCE_A, OCCURRENCE_B],
        },
      },
    };

    const instrShards: Record<string, InstructionShard> = {
      [instrPrefix]: { [instrHash]: [blobA, blobB].sort() },
    };

    const indexDir = await makeIndex({ exactShards, instrShards });
    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

    expect(report.match.type).toBe("same_instructions");
    if (report.match.type === "same_instructions") {
      expect(report.match.rawVariantCount).toBe(2);
      // copyCount = 3 from blobA (blobB has no exact entry)
      expect(report.match.copyCount).toBe(3);
    }
  });

  it("contentHashes are sorted deterministically with sha1: prefix", async () => {
    const bodyA = "# Skill\n\nContent.\n";
    const bodyB = "---\nname: x\n---\n# Skill\n\nContent.\n";
    const skillDir = await makeTempSkill({ "SKILL.md": bodyB });

    const blobA = computeGitBlobSha1(Buffer.from(bodyA, "utf-8")).replace(/^sha1:/, "");
    const blobB = computeGitBlobSha1(Buffer.from(bodyB, "utf-8")).replace(/^sha1:/, "");
    const instrHash = instrHex(bodyA);
    const instrPrefix = instrHash.slice(0, 2);

    const exactShards: Record<string, IndexShard> = {
      [blobA.slice(0, 2)]: {
        [blobA]: { copyCount: 1, occurrences: [OCCURRENCE_A] },
      },
    };

    const instrShards: Record<string, InstructionShard> = {
      [instrPrefix]: { [instrHash]: [blobA, blobB].sort() },
    };

    const indexDir = await makeIndex({ exactShards, instrShards });
    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

    if (report.match.type === "same_instructions") {
      const hashes = [...report.match.contentHashes];
      const sorted = [...hashes].sort();
      expect(hashes).toEqual(sorted);
      for (const h of hashes) {
        expect(h).toMatch(/^sha1:[a-f0-9]{40}$/);
      }
    }
  });

  it("occurrences are sorted by repoFullName then path", async () => {
    const bodyA = "# Skill\n\nContent.\n";
    const bodyB = "---\nname: x\n---\n# Skill\n\nContent.\n";
    const skillDir = await makeTempSkill({ "SKILL.md": bodyB });

    const blobA = computeGitBlobSha1(Buffer.from(bodyA, "utf-8")).replace(/^sha1:/, "");
    const instrHash = instrHex(bodyA);
    const instrPrefix = instrHash.slice(0, 2);

    const occurrences = [
      { ...OCCURRENCE_B }, // bob/skills
      { ...OCCURRENCE_A }, // alice/skills — should sort first
    ];

    const exactShards: Record<string, IndexShard> = {
      [blobA.slice(0, 2)]: {
        [blobA]: { copyCount: 2, occurrences },
      },
    };

    const instrShards: Record<string, InstructionShard> = {
      [instrPrefix]: { [instrHash]: [blobA] },
    };

    const indexDir = await makeIndex({ exactShards, instrShards });
    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

    if (report.match.type === "same_instructions") {
      expect(report.match.occurrences[0]?.repoFullName).toBe("alice/skills");
      expect(report.match.occurrences[1]?.repoFullName).toBe("bob/skills");
    }
  });

  it("trace is deterministic for same_instructions", async () => {
    const bodyA = "# Skill\n\nContent.\n";
    const bodyB = "---\nname: x\n---\n# Skill\n\nContent.\n";
    const skillDir = await makeTempSkill({ "SKILL.md": bodyB });

    const blobA = computeGitBlobSha1(Buffer.from(bodyA, "utf-8")).replace(/^sha1:/, "");
    const instrHash = instrHex(bodyA);
    const instrPrefix = instrHash.slice(0, 2);

    const exactShards: Record<string, IndexShard> = {
      [blobA.slice(0, 2)]: {
        [blobA]: { copyCount: 1, occurrences: [OCCURRENCE_A] },
      },
    };

    const instrShards: Record<string, InstructionShard> = {
      [instrPrefix]: { [instrHash]: [blobA] },
    };

    const indexDir = await makeIndex({ exactShards, instrShards });
    const r1 = await traceSkill(skillDir, indexDir, TOOL_VERSION);
    const r2 = await traceSkill(skillDir, indexDir, TOOL_VERSION);

    expect(r1).toEqual(r2);
  });

  it("reads each required exact shard at most once", async () => {
    const hashes = [
      "aa" + "0".repeat(38),
      "aa" + "1".repeat(38),
      "bb" + "0".repeat(38),
      "aa" + "0".repeat(38),
    ];
    const reads = new Map<string, number>();

    const result = await buildSameInstructionsMatch("unused", hashes, (_dir, prefix) => {
      reads.set(prefix, (reads.get(prefix) ?? 0) + 1);
      if (prefix === "aa") {
        return Promise.resolve({
          [hashes[0]]: { copyCount: 1, occurrences: [OCCURRENCE_A] },
          [hashes[1]]: { copyCount: 1, occurrences: [OCCURRENCE_A] },
        });
      }
      return Promise.resolve({
        [hashes[2]]: { copyCount: 1, occurrences: [OCCURRENCE_B] },
      });
    });

    expect(reads).toEqual(new Map([["aa", 1], ["bb", 1]]));
    expect(result.rawVariantCount).toBe(3);
    expect(result.contentHashes).toHaveLength(3);
    expect(result.occurrences).toEqual([OCCURRENCE_A, OCCURRENCE_B]);
    expect(result.copyCount).toBe(2);
  });
});

describe("variant_candidates match", () => {
  it("returns approximate candidates with deterministic capped examples", async () => {
    const indexed = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen\n";
    const local = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen changed\n";
    const skillDir = await makeTempSkill({ "SKILL.md": local });
    const indexedBlob = computeGitBlobSha1(Buffer.from(indexed, "utf-8")).replace(/^sha1:/, "");
    const fullInstructionHash = instrHex(indexed);
    const variantId = variantIdFromInstructionsSha256(fullInstructionHash);
    const candidateSketch = instructionSketch(normalizeInstructions(indexed));
    const localSketch = instructionSketch(normalizeInstructions(local));
    const sharedAnchors = localSketch.slice(0, 8).filter((anchor) => candidateSketch.includes(anchor));
    expect(sharedAnchors.length).toBeGreaterThanOrEqual(2);

    const anchorShards: Record<string, AnchorShard> = {};
    for (const anchor of sharedAnchors) {
      const prefix = anchor.slice(0, 2);
      anchorShards[prefix] ??= {};
      anchorShards[prefix][anchor] = [variantId];
    }
    const occurrences = [
      { ...OCCURRENCE_A, repoFullName: "low/repo", stars: 1 },
      { ...OCCURRENCE_B, repoFullName: "null/repo", stars: null },
      { ...OCCURRENCE_C, repoFullName: "top/repo", stars: 900 },
      { ...OCCURRENCE_C, repoFullName: "mid/repo", stars: 50, path: "mid/SKILL.md" },
    ];
    const indexDir = await makeIndex({
      exactShards: {
        [indexedBlob.slice(0, 2)]: {
          [indexedBlob]: { copyCount: 4, occurrences },
        },
      },
      instrShards: {
        [fullInstructionHash.slice(0, 2)]: {
          [fullInstructionHash]: [indexedBlob],
        },
      },
      sketchShards: {
        [variantId.slice(0, 2)]: {
          [variantId]: { instructionsSha256: fullInstructionHash, sketch: candidateSketch },
        },
      },
      anchorShards,
    });

    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);
    expect(report.match.type).toBe("variant_candidates");
    if (report.match.type === "variant_candidates") {
      expect(report.match.approximate).toBe(true);
      expect(report.match.method).toBe("bottom-k-token-shingles-v1");
      expect(report.match.candidates).toHaveLength(1);
      expect(report.match.candidates[0].examples).toHaveLength(3);
      expect(report.match.candidates[0].examples.map((example) => example.stars)).toEqual([900, 50, 1]);
    }
    expect(report.origin.status).toBe("not_inferred");
  });
});

// ---------------------------------------------------------------------------
// None match
// ---------------------------------------------------------------------------

describe("none match", () => {
  it("returns none when skill is not in exact or instruction index", async () => {
    const skillDir = await makeTempSkill({
      "SKILL.md": "# Truly unique skill nobody has seen.\n",
    });

    // Complete index with all 256 shards, all empty
    const indexDir = await makeIndex({});

    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

    expect(report.match.type).toBe("none");
    if (report.match.type === "none") {
      expect(report.match.copyCount).toBe(0);
      expect(report.match.occurrences).toEqual([]);
    }
  });

  it("unrelated instructions return none", async () => {
    const skillDir = await makeTempSkill({
      "SKILL.md": "# Completely different skill.\n\nNothing in common.\n",
    });

    const indexDir = await makeIndex({});
    const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

    expect(report.match.type).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("trace errors", () => {
  it("fails when index directory does not exist", async () => {
    const skillDir = await makeTempSkill({ "SKILL.md": "# Skill\n" });
    await expect(
      traceSkill(skillDir, "/nonexistent/index/path", TOOL_VERSION),
    ).rejects.toThrow(TraceError);
  });

  it("fails when manifest is missing", async () => {
    const skillDir = await makeTempSkill({ "SKILL.md": "# Skill\n" });
    const indexDir = await makeTempDir();

    await expect(
      traceSkill(skillDir, indexDir, TOOL_VERSION),
    ).rejects.toThrow(IndexError);
  });

  it("fails when SKILL.md is missing", async () => {
    const skillDir = await makeTempDir();
    await writeFile(path.join(skillDir, "README.md"), "# Readme\n");

    const indexDir = await makeIndex({});
    await expect(
      traceSkill(skillDir, indexDir, TOOL_VERSION),
    ).rejects.toThrow(FingerprintError);
  });
});
