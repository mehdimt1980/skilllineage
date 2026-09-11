import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { normalizeInstructions } from "../fingerprint/index.js";
import {
  instructionSketch,
  shingleHash96,
  variantIdFromInstructionsSha256,
} from "../variant/index.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skilllineage-builder-"));
  tempDirs.push(dir);
  return dir;
}

const BUILDER_PATH = path.resolve("tools/build-gitskills-index.py");
const DB_CREATOR_PATH = path.resolve("tools/create-test-db.py");

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true });
  }
});

interface TestArtifact {
  file_sha: string;
  repo_full_name: string;
  path: string;
  location_class?: string | null;
  first_commit_at?: string | null;
  last_commit_at?: string | null;
  history_fetched?: number | null;
  content?: string | null;
}

interface TestFixture {
  repos: Array<{ full_name: string; stars?: number }>;
  artifacts: TestArtifact[];
}

async function createTestDb(
  dbPath: string,
  fixture: TestFixture,
): Promise<void> {
  const jsonPath = dbPath + ".fixture.json";
  await writeFile(jsonPath, JSON.stringify(fixture), "utf-8");
  await execFileAsync("python", [DB_CREATOR_PATH, dbPath, jsonPath]);
}

async function runBuilder(
  dbPath: string,
  outDir: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("python", [
    BUILDER_PATH,
    dbPath,
    outDir,
    "--source-snapshot",
    "2026-07",
  ]);
}

function instrSha256(content: string): string {
  const normalized = normalizeInstructions(content);
  return createHash("sha256")
    .update(Buffer.from(normalized, "utf-8"))
    .digest("hex");
}

function readGzipShard(buf: Buffer): Record<string, unknown> {
  return JSON.parse(gunzipSync(buf).toString("utf-8")) as Record<
    string,
    unknown
  >;
}

// ---------------------------------------------------------------------------
// Fixture: two raw contents with same normalized body (frontmatter variants)
// ---------------------------------------------------------------------------

const BODY_PLAIN =
  "# Example Skill\n\nThis skill does something useful.\nIt supports multiple features.\n";
const BODY_WITH_FM_A =
  "---\nname: skill-a\n---\n# Example Skill\n\nThis skill does something useful.\nIt supports multiple features.\n";
const BODY_WITH_FM_B =
  "---\nname: skill-b\nauthor: someone\n---\n# Example Skill\n\nThis skill does something useful.\nIt supports multiple features.\n";
const BODY_CRLF =
  "# Example Skill\r\n\r\nThis skill does something useful.\r\nIt supports multiple features.\r\n";
const BODY_BOM = "\uFEFF# Example Skill\n\nThis skill does something useful.\nIt supports multiple features.\n";
const BODY_TRAILING = "# Example Skill   \n\nThis skill does something useful.\t\nIt supports multiple features.\n";
const BODY_UNRELATED =
  "# Database Migrator\n\nManages schema migrations.\nSupports PostgreSQL.\n";

// Synthetic file_sha values (not real git hashes, just hex strings for testing)
const SHA_PLAIN = "aa" + "0".repeat(38);
const SHA_FM_A = "aa" + "1".repeat(38);
const SHA_FM_B = "aa" + "2".repeat(38);
const SHA_CRLF = "aa" + "3".repeat(38);
const SHA_BOM = "bb" + "0".repeat(38);
const SHA_TRAILING = "bb" + "1".repeat(38);
const SHA_UNRELATED = "cc" + "0".repeat(38);

const PARITY_FIXTURE: TestFixture = {
  repos: [
    { full_name: "alice/skills", stars: 50 },
    { full_name: "bob/tools", stars: 10 },
    { full_name: "carol/agents", stars: 200 },
    { full_name: "dave/demo", stars: 5 },
    { full_name: "eve/misc", stars: 3 },
    { full_name: "frank/stuff", stars: 1 },
    { full_name: "grace/unrelated", stars: 100 },
  ],
  artifacts: [
    {
      file_sha: SHA_PLAIN,
      repo_full_name: "alice/skills",
      path: "SKILL.md",
      content: BODY_PLAIN,
    },
    {
      file_sha: SHA_FM_A,
      repo_full_name: "bob/tools",
      path: "skills/SKILL.md",
      content: BODY_WITH_FM_A,
    },
    {
      file_sha: SHA_FM_B,
      repo_full_name: "carol/agents",
      path: "SKILL.md",
      content: BODY_WITH_FM_B,
    },
    {
      file_sha: SHA_CRLF,
      repo_full_name: "dave/demo",
      path: "SKILL.md",
      content: BODY_CRLF,
    },
    {
      file_sha: SHA_BOM,
      repo_full_name: "eve/misc",
      path: "SKILL.md",
      content: BODY_BOM,
    },
    {
      file_sha: SHA_TRAILING,
      repo_full_name: "frank/stuff",
      path: "SKILL.md",
      content: BODY_TRAILING,
    },
    {
      file_sha: SHA_UNRELATED,
      repo_full_name: "grace/unrelated",
      path: "SKILL.md",
      content: BODY_UNRELATED,
    },
    // Artifact with no content — should be skipped in instruction index
    {
      file_sha: "dd" + "0".repeat(38),
      repo_full_name: "alice/skills",
      path: "other/SKILL.md",
      content: null,
    },
    // Lowercase skill.md — excluded from both indexes
    {
      file_sha: "ee" + "0".repeat(38),
      repo_full_name: "alice/skills",
      path: "bad/skill.md",
      content: BODY_PLAIN,
    },
  ],
};

// ---------------------------------------------------------------------------
// 256-shard completeness
// ---------------------------------------------------------------------------

describe("256-shard completeness", () => {
  it("builder creates exactly 256 exact shards", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");

    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir);

    const files = await readdir(path.join(outDir, "exact"));
    const gzFiles = files.filter((f) => f.endsWith(".json.gz"));
    expect(gzFiles).toHaveLength(256);
  });

  it("builder creates exactly 256 instruction shards", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");

    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir);

    const files = await readdir(path.join(outDir, "instructions"));
    const gzFiles = files.filter((f) => f.endsWith(".json.gz"));
    expect(gzFiles).toHaveLength(256);
  });

  it("empty shards decompress to valid {}", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");

    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir);

    // Find a shard prefix that has no data (e.g., "ff" is unlikely to be populated)
    // Verify it's {} by checking several
    for (const prefix of ["00", "11", "22", "33"]) {
      const exactPath = path.join(outDir, "exact", `${prefix}.json.gz`);
      const instrPath = path.join(outDir, "instructions", `${prefix}.json.gz`);

      const exactBuf = await readFile(exactPath);
      const instrBuf = await readFile(instrPath);

      // Decompress and parse — should be valid objects (possibly empty)
      const exactShard = readGzipShard(exactBuf);
      const instrShard = readGzipShard(instrBuf);

      expect(typeof exactShard).toBe("object");
      expect(typeof instrShard).toBe("object");
      // These specific prefixes have no test data, so should be {}
      if (!Object.keys(exactShard).some((k) => k.startsWith(prefix))) {
        expect(exactShard).toEqual({});
        expect(gunzipSync(exactBuf).toString("utf-8")).toBe("{}");
      }
      if (!Object.keys(instrShard).some((k) => k.startsWith(prefix))) {
        expect(instrShard).toEqual({});
        expect(gunzipSync(instrBuf).toString("utf-8")).toBe("{}");
      }
    }
  });

  it("builder creates all 256 sketch and anchor shards", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");
    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir);
    expect((await readdir(path.join(outDir, "variants", "sketches"))).filter((f) => f.endsWith(".json.gz"))).toHaveLength(256);
    expect((await readdir(path.join(outDir, "variants", "anchors"))).filter((f) => f.endsWith(".json.gz"))).toHaveLength(256);
  });
});

// ---------------------------------------------------------------------------
// Python / TypeScript normalization parity
// ---------------------------------------------------------------------------

describe("Python/TypeScript normalization parity", () => {
  async function buildAndGetInstrShard(
    fixture: TestFixture,
  ): Promise<{ outDir: string; tmpDir: string }> {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");
    await createTestDb(dbPath, fixture);
    await runBuilder(dbPath, outDir);
    return { outDir, tmpDir };
  }

  it("plain SKILL.md — Python hash matches TypeScript", async () => {
    const tsHash = instrSha256(BODY_PLAIN);
    const prefix = tsHash.slice(0, 2);

    const { outDir } = await buildAndGetInstrShard({
      repos: [{ full_name: "test/repo", stars: 1 }],
      artifacts: [
        {
          file_sha: SHA_PLAIN,
          repo_full_name: "test/repo",
          path: "SKILL.md",
          content: BODY_PLAIN,
        },
      ],
    });

    const shard = readGzipShard(
      await readFile(path.join(outDir, "instructions", `${prefix}.json.gz`)),
    );
    expect(Object.prototype.hasOwnProperty.call(shard, tsHash)).toBe(true);
  });

  it("YAML frontmatter — Python hash matches TypeScript", async () => {
    const tsHash = instrSha256(BODY_WITH_FM_A);
    const prefix = tsHash.slice(0, 2);

    const { outDir } = await buildAndGetInstrShard({
      repos: [{ full_name: "test/repo", stars: 1 }],
      artifacts: [
        {
          file_sha: SHA_FM_A,
          repo_full_name: "test/repo",
          path: "SKILL.md",
          content: BODY_WITH_FM_A,
        },
      ],
    });

    const shard = readGzipShard(
      await readFile(path.join(outDir, "instructions", `${prefix}.json.gz`)),
    );
    expect(Object.prototype.hasOwnProperty.call(shard, tsHash)).toBe(true);
  });

  it("changed frontmatter same body — same instruction hash in both Python and TypeScript", async () => {
    const tsHashA = instrSha256(BODY_WITH_FM_A);
    const tsHashB = instrSha256(BODY_WITH_FM_B);
    expect(tsHashA).toBe(tsHashB);

    const prefix = tsHashA.slice(0, 2);

    const { outDir } = await buildAndGetInstrShard({
      repos: [
        { full_name: "alice/skills", stars: 1 },
        { full_name: "bob/tools", stars: 1 },
      ],
      artifacts: [
        {
          file_sha: SHA_FM_A,
          repo_full_name: "alice/skills",
          path: "SKILL.md",
          content: BODY_WITH_FM_A,
        },
        {
          file_sha: SHA_FM_B,
          repo_full_name: "bob/tools",
          path: "SKILL.md",
          content: BODY_WITH_FM_B,
        },
      ],
    });

    const shard = readGzipShard(
      await readFile(path.join(outDir, "instructions", `${prefix}.json.gz`)),
    ) as Record<string, string[]>;
    const entry = shard[tsHashA] as string[] | undefined;
    expect(entry).toBeDefined();
    // Both file_shas should map to the same instruction hash
    expect(entry?.length).toBe(2);
    expect(entry).toContain(SHA_FM_A);
    expect(entry).toContain(SHA_FM_B);
  });

  it("CRLF — Python hash matches TypeScript", async () => {
    const tsHash = instrSha256(BODY_CRLF);
    // CRLF and LF should produce the same hash as plain
    const tsHashPlain = instrSha256(BODY_PLAIN);
    expect(tsHash).toBe(tsHashPlain);

    const prefix = tsHash.slice(0, 2);

    const { outDir } = await buildAndGetInstrShard({
      repos: [{ full_name: "test/repo", stars: 1 }],
      artifacts: [
        {
          file_sha: SHA_CRLF,
          repo_full_name: "test/repo",
          path: "SKILL.md",
          content: BODY_CRLF,
        },
      ],
    });

    const shard = readGzipShard(
      await readFile(path.join(outDir, "instructions", `${prefix}.json.gz`)),
    );
    expect(Object.prototype.hasOwnProperty.call(shard, tsHash)).toBe(true);
  });

  it("UTF-8 BOM — Python hash matches TypeScript", async () => {
    const tsHash = instrSha256(BODY_BOM);
    const tsHashPlain = instrSha256(BODY_PLAIN);
    expect(tsHash).toBe(tsHashPlain);

    const prefix = tsHash.slice(0, 2);

    const { outDir } = await buildAndGetInstrShard({
      repos: [{ full_name: "test/repo", stars: 1 }],
      artifacts: [
        {
          file_sha: SHA_BOM,
          repo_full_name: "test/repo",
          path: "SKILL.md",
          content: BODY_BOM,
        },
      ],
    });

    const shard = readGzipShard(
      await readFile(path.join(outDir, "instructions", `${prefix}.json.gz`)),
    );
    expect(Object.prototype.hasOwnProperty.call(shard, tsHash)).toBe(true);
  });

  it("trailing spaces/tabs — Python hash matches TypeScript", async () => {
    const tsHash = instrSha256(BODY_TRAILING);
    const tsHashPlain = instrSha256(BODY_PLAIN);
    expect(tsHash).toBe(tsHashPlain);

    const prefix = tsHash.slice(0, 2);

    const { outDir } = await buildAndGetInstrShard({
      repos: [{ full_name: "test/repo", stars: 1 }],
      artifacts: [
        {
          file_sha: SHA_TRAILING,
          repo_full_name: "test/repo",
          path: "SKILL.md",
          content: BODY_TRAILING,
        },
      ],
    });

    const shard = readGzipShard(
      await readFile(path.join(outDir, "instructions", `${prefix}.json.gz`)),
    );
    expect(Object.prototype.hasOwnProperty.call(shard, tsHash)).toBe(true);
  });

  it("empty instruction body — Python hash matches TypeScript", async () => {
    const emptyContent = "---\nname: x\n---\n";
    // After stripping frontmatter body is empty — normalization produces "\n"
    const tsHash = instrSha256(emptyContent);

    const prefix = tsHash.slice(0, 2);
    const emptySha = "ff" + "0".repeat(38);

    const { outDir } = await buildAndGetInstrShard({
      repos: [{ full_name: "test/repo", stars: 1 }],
      artifacts: [
        {
          file_sha: emptySha,
          repo_full_name: "test/repo",
          path: "SKILL.md",
          content: emptyContent,
        },
      ],
    });

    const shard = readGzipShard(
      await readFile(path.join(outDir, "instructions", `${prefix}.json.gz`)),
    );
    expect(Object.prototype.hasOwnProperty.call(shard, tsHash)).toBe(true);
  });
});

describe("Python/TypeScript variant sketch parity", () => {
  it("matches hashes, sketches, and variant IDs across canonical edge cases", async () => {
    const cases = [
      "Ordinary English instructions have several useful words here.\n",
      "# Heading\n\nUse commas, periods, and code: `run()`.\n",
      "---\nname: parity\n---\nOne two three four five six.\n",
      "One two three four five six.\r\n",
      "repeat one two three four repeat one two three four\n",
      "one two three\n",
      "---\nname: empty\n---\n",
      "one\ttwo\tthree four five six\n",
      "one\u00a0two\u2003three\u202ffour five six\n",
    ];
    const fixture: TestFixture = {
      repos: [{ full_name: "parity/repo", stars: 1 }],
      artifacts: cases.map((content, i) => ({
        file_sha: i.toString(16).padStart(40, "0"),
        repo_full_name: "parity/repo",
        path: `skills/${i}/SKILL.md`,
        content,
      })),
    };
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");
    await createTestDb(dbPath, fixture);
    await runBuilder(dbPath, outDir);

    for (const content of cases) {
      const fullHash = instrSha256(content);
      const variantId = variantIdFromInstructionsSha256(fullHash);
      const shard = readGzipShard(await readFile(path.join(
        outDir, "variants", "sketches", `${variantId.slice(0, 2)}.json.gz`,
      ))) as Record<string, { instructionsSha256: string; sketch: string[] }>;
      expect(shard[variantId]).toEqual({
        instructionsSha256: fullHash,
        sketch: instructionSketch(normalizeInstructions(content)),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Instruction index semantics
// ---------------------------------------------------------------------------

describe("instruction index semantics", () => {
  it("multiple raw hashes with same normalized body are grouped", async () => {
    const tsHash = instrSha256(BODY_PLAIN);
    // BODY_PLAIN, BODY_WITH_FM_A, BODY_WITH_FM_B, BODY_CRLF, BODY_BOM, BODY_TRAILING
    // all normalize to the same body
    const sameHashes = [SHA_PLAIN, SHA_FM_A, SHA_FM_B, SHA_CRLF, SHA_BOM, SHA_TRAILING];
    const prefix = tsHash.slice(0, 2);

    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");

    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir);

    const shard = readGzipShard(
      await readFile(path.join(outDir, "instructions", `${prefix}.json.gz`)),
    ) as Record<string, string[]>;

    const entry = shard[tsHash];
    expect(entry).toBeDefined();
    expect(entry.length).toBe(6);
    for (const sha of sameHashes) {
      expect(entry).toContain(sha);
    }
  });

  it("blob hashes within an instruction entry are sorted lexicographically", async () => {
    const tsHash = instrSha256(BODY_PLAIN);
    const prefix = tsHash.slice(0, 2);

    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");

    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir);

    const shard = readGzipShard(
      await readFile(path.join(outDir, "instructions", `${prefix}.json.gz`)),
    ) as Record<string, string[]>;

    const hashes = shard[tsHash];
    expect(hashes).toEqual([...hashes].sort());
  });

  it("builder skips representative rows with missing content", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");

    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir);

    const manifestRaw = await readFile(
      path.join(outDir, "manifest.json"),
      "utf-8",
    );
    const manifest = JSON.parse(manifestRaw) as Record<
      string,
      Record<string, number>
    >;

    // dd00... artifact has no content and should be skipped
    expect(
      manifest.instructionIndex.skippedDistinctContentCount,
    ).toBeGreaterThan(0);
  });

  it("manifest reports instructionIndex statistics", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");

    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir);

    const manifestRaw = await readFile(
      path.join(outDir, "manifest.json"),
      "utf-8",
    );
    const manifest = JSON.parse(manifestRaw) as {
      instructionIndex: {
        indexedDistinctContentCount: number;
        skippedDistinctContentCount: number;
      };
    };

    expect(
      typeof manifest.instructionIndex.indexedDistinctContentCount,
    ).toBe("number");
    expect(
      typeof manifest.instructionIndex.skippedDistinctContentCount,
    ).toBe("number");
    expect(manifest.instructionIndex.indexedDistinctContentCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Existing exact-index behavior
// ---------------------------------------------------------------------------

describe("exact index", () => {
  it("groups duplicate raw hashes correctly", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");

    const fixture: TestFixture = {
      repos: [
        { full_name: "alice/skills", stars: 120 },
        { full_name: "bob/tools", stars: 45 },
      ],
      artifacts: [
        {
          file_sha: "ab12345678901234567890123456789012345678",
          repo_full_name: "alice/skills",
          path: "SKILL.md",
          content: BODY_PLAIN,
        },
        {
          file_sha: "ab12345678901234567890123456789012345678",
          repo_full_name: "bob/tools",
          path: "skills/SKILL.md",
          content: BODY_PLAIN,
        },
      ],
    };

    await createTestDb(dbPath, fixture);
    await runBuilder(dbPath, outDir);

    const shard = readGzipShard(
      await readFile(path.join(outDir, "exact", "ab.json.gz")),
    ) as Record<string, { copyCount: number; occurrences: unknown[] }>;

    const entry = shard["ab12345678901234567890123456789012345678"] as
      | { copyCount: number; occurrences: unknown[] }
      | undefined;
    expect(entry?.copyCount).toBe(2);
    expect(entry?.occurrences).toHaveLength(2);
  });

  it("excludes lowercase skill.md from exact index", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");

    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir);

    // ee00... was the lowercase skill.md — should not be in any shard
    const eeShard = readGzipShard(
      await readFile(path.join(outDir, "exact", "ee.json.gz")),
    );

    expect(
      Object.prototype.hasOwnProperty.call(eeShard, "ee" + "0".repeat(38)),
    ).toBe(false);
  });

  it("serializes known-null occurrence metadata explicitly", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");
    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir);
    const shard = readGzipShard(await readFile(path.join(outDir, "exact", "aa.json.gz"))) as Record<string, { occurrences: Array<Record<string, unknown>> }>;
    const occurrence = shard[SHA_PLAIN].occurrences[0];
    for (const field of ["locationClass", "firstCommitAt", "lastCommitAt", "historyFetched"]) {
      expect(occurrence).toHaveProperty(field, null);
    }
  });
});

describe("variant index", () => {
  it("contains no source Skill text", async () => {
    const marker = "SECRET-SOURCE-MARKER";
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");
    await createTestDb(dbPath, {
      repos: [{ full_name: "safe/repo", stars: 1 }],
      artifacts: [{
        file_sha: "12" + "0".repeat(38), repo_full_name: "safe/repo",
        path: "SKILL.md", content: `# ${marker}\none two three four five six\n`,
      }],
    });
    await runBuilder(dbPath, outDir);
    for (const subdir of ["sketches", "anchors"]) {
      for (const file of await readdir(path.join(outDir, "variants", subdir))) {
        const text = gunzipSync(await readFile(path.join(outDir, "variants", subdir, file))).toString("utf-8");
        expect(text).not.toContain(marker);
      }
    }
  });

  it("omits hot anchors and reports their count", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir = path.join(tmpDir, "index");
    const artifacts = Array.from({ length: 2001 }, (_, i) => ({
      file_sha: (i + 1).toString(16).padStart(40, "0"),
      repo_full_name: "hot/repo",
      path: `skills/${i}/SKILL.md`,
      content: `common one two three four unique-${i}\n`,
    }));
    await createTestDb(dbPath, {
      repos: [{ full_name: "hot/repo", stars: 1 }], artifacts,
    });
    await runBuilder(dbPath, outDir);
    const anchor = shingleHash96("common one two three four");
    const shard = readGzipShard(await readFile(path.join(
      outDir, "variants", "anchors", `${anchor.slice(0, 2)}.json.gz`,
    )));
    expect(shard).not.toHaveProperty(anchor);
    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8")) as { variantIndex: { skippedHotAnchorCount: number } };
    expect(manifest.variantIndex.skippedHotAnchorCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("produces byte-identical instruction shards across two builds", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir1 = path.join(tmpDir, "index1");
    const outDir2 = path.join(tmpDir, "index2");

    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir1);
    await runBuilder(dbPath, outDir2);

    const files1 = await readdir(path.join(outDir1, "instructions"));
    for (const f of files1) {
      const c1 = await readFile(path.join(outDir1, "instructions", f));
      const c2 = await readFile(path.join(outDir2, "instructions", f));
      expect(c1.equals(c2)).toBe(true);
    }
  });

  it("produces byte-identical exact shards across two builds", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir1 = path.join(tmpDir, "index1");
    const outDir2 = path.join(tmpDir, "index2");

    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir1);
    await runBuilder(dbPath, outDir2);

    const files1 = await readdir(path.join(outDir1, "exact"));
    for (const f of files1) {
      const c1 = await readFile(path.join(outDir1, "exact", f));
      const c2 = await readFile(path.join(outDir2, "exact", f));
      expect(c1.equals(c2)).toBe(true);
    }
  });

  it("produces byte-identical variant shards across two builds", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const outDir1 = path.join(tmpDir, "index1");
    const outDir2 = path.join(tmpDir, "index2");
    await createTestDb(dbPath, PARITY_FIXTURE);
    await runBuilder(dbPath, outDir1);
    await runBuilder(dbPath, outDir2);
    for (const subdir of ["sketches", "anchors"]) {
      for (const file of await readdir(path.join(outDir1, "variants", subdir))) {
        const first = await readFile(path.join(outDir1, "variants", subdir, file));
        const second = await readFile(path.join(outDir2, "variants", subdir, file));
        expect(first.equals(second)).toBe(true);
      }
    }
  });
});
