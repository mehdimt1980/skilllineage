import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile, stat } from "node:fs/promises";
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
  anchorShardPrefix,
  variantIdFromInstructionsSha256,
} from "../variant/index.js";
import { variantSketchRoute } from "./routing.js";

const execFileAsync = promisify(execFile);
let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skilllineage-builder-"));
  tempDirs.push(dir);
  return dir;
}

const BUILDER_PATH = path.resolve("tools/build-gitskills-index.py");
const DB_CREATOR_PATH = path.resolve("tools/create-test-db.py");

beforeEach(() => { tempDirs = []; });
afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
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

async function createTestDb(dbPath: string, fixture: TestFixture): Promise<void> {
  const jsonPath = `${dbPath}.fixture.json`;
  await writeFile(jsonPath, JSON.stringify(fixture), "utf-8");
  await execFileAsync("python", [DB_CREATOR_PATH, dbPath, jsonPath]);
}

async function runBuilder(dbPath: string, outDir: string): Promise<void> {
  await execFileAsync("python", [
    BUILDER_PATH,
    dbPath,
    outDir,
    "--source-snapshot",
    "2026-07",
  ]);
}

function instrSha256(content: string): string {
  return createHash("sha256")
    .update(Buffer.from(normalizeInstructions(content), "utf-8"))
    .digest("hex");
}

function readGzipShard(buf: Buffer): Record<string, unknown> {
  return JSON.parse(gunzipSync(buf).toString("utf-8")) as Record<string, unknown>;
}

async function filesRecursively(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current)) {
      const absolute = path.join(current, entry);
      if ((await stat(absolute)).isDirectory()) await walk(absolute);
      else result.push(absolute);
    }
  }
  await walk(root);
  return result.sort();
}

const BODY = "# Example Skill\n\nThis skill does something useful with one two three four five six seven eight.\n";
const BODY_WITH_FRONTMATTER = `---\nname: example\n---\n${BODY}`;
const UNRELATED = "# Database Migrator\n\nManages schema migrations with alpha beta gamma delta epsilon zeta.\n";
const SHA_A = "aa" + "0".repeat(38);
const SHA_B = "bb" + "1".repeat(38);
const SHA_C = "cc" + "2".repeat(38);

const FIXTURE: TestFixture = {
  repos: [
    { full_name: "alice/skills", stars: 50 },
    { full_name: "bob/tools", stars: 10 },
    { full_name: "carol/agents", stars: 200 },
  ],
  artifacts: [
    { file_sha: SHA_A, repo_full_name: "alice/skills", path: "SKILL.md", content: BODY },
    { file_sha: SHA_B, repo_full_name: "bob/tools", path: "skills/SKILL.md", content: BODY_WITH_FRONTMATTER },
    { file_sha: SHA_C, repo_full_name: "carol/agents", path: "SKILL.md", content: UNRELATED },
    { file_sha: "dd" + "0".repeat(38), repo_full_name: "alice/skills", path: "other/SKILL.md", content: null },
    { file_sha: "ee" + "0".repeat(38), repo_full_name: "alice/skills", path: "bad/skill.md", content: BODY },
  ],
};

async function buildFixture(fixture: TestFixture = FIXTURE): Promise<{ outDir: string; dbPath: string }> {
  const tmpDir = await makeTempDir();
  const dbPath = path.join(tmpDir, "test.db");
  const outDir = path.join(tmpDir, "index");
  await createTestDb(dbPath, fixture);
  await runBuilder(dbPath, outDir);
  return { outDir, dbPath };
}

describe("schema 0.3 index layout", () => {
  it("keeps exact, instruction, and anchor stores at 256 two-hex shards", async () => {
    const { outDir } = await buildFixture();
    for (const relative of ["exact", "instructions", "variants/anchors"]) {
      const files = (await readdir(path.join(outDir, relative))).filter((file) => file.endsWith(".json.gz"));
      expect(files).toHaveLength(256);
    }
  });

  it("writes only non-empty nested sketch micro-shards", async () => {
    const { outDir } = await buildFixture();
    const sketchRoot = path.join(outDir, "variants", "sketches");
    const files = (await filesRecursively(sketchRoot)).filter((file) => file.endsWith(".json.gz"));
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThan(256);
    for (const file of files) {
      const relative = path.relative(sketchRoot, file).replaceAll("\\", "/");
      expect(relative).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\.json\.gz$/);
      expect(Object.keys(readGzipShard(await readFile(file))).length).toBeGreaterThan(0);
    }
  });

  it("stores a variant record at the exact first-four-hex route", async () => {
    const { outDir } = await buildFixture();
    const fullHash = instrSha256(BODY);
    const variantId = variantIdFromInstructionsSha256(fullHash);
    const route = variantSketchRoute(variantId);
    const shardPath = path.join(outDir, "variants", "sketches", route.directory, `${route.file}.json.gz`);
    const shard = readGzipShard(await readFile(shardPath)) as Record<string, { instructionsSha256: string; sketch: string[] }>;
    expect(shard[variantId]).toEqual({
      instructionsSha256: fullHash,
      sketch: instructionSketch(normalizeInstructions(BODY)),
    });
  });

  it("declares schema 0.3 and both routing algorithms", async () => {
    const { outDir } = await buildFixture();
    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8")) as {
      schemaVersion: string;
      variantIndex: { anchorShardRouting: string; sketchShardRouting: string };
    };
    expect(manifest.schemaVersion).toBe("0.3");
    expect(manifest.variantIndex.anchorShardRouting).toBe("sha256-anchor-hex-v1");
    expect(manifest.variantIndex.sketchShardRouting).toBe("variant-id-hex4-v1");
  });
});

describe("normalization and instruction semantics", () => {
  it("groups raw variants that normalize to the same instruction body", async () => {
    const { outDir } = await buildFixture();
    const hash = instrSha256(BODY);
    expect(hash).toBe(instrSha256(BODY_WITH_FRONTMATTER));
    const shard = readGzipShard(await readFile(path.join(outDir, "instructions", `${hash.slice(0, 2)}.json.gz`))) as Record<string, string[]>;
    expect(shard[hash]).toEqual([SHA_A, SHA_B].sort());
  });

  it("preserves TypeScript sketch content across canonical edge cases", async () => {
    const cases = [
      "one two three four five six seven eight\n",
      "---\nname: parity\n---\none two three four five six\n",
      "one two three\n",
      "one\ttwo\tthree four five six\n",
      "one\u00a0two\u2003three\u202ffour five six\n",
    ];
    const fixture: TestFixture = {
      repos: [{ full_name: "parity/repo", stars: 1 }],
      artifacts: cases.map((content, index) => ({
        file_sha: (index + 1).toString(16).padStart(40, "0"),
        repo_full_name: "parity/repo",
        path: `skills/${index}/SKILL.md`,
        content,
      })),
    };
    const { outDir } = await buildFixture(fixture);
    for (const content of cases) {
      const fullHash = instrSha256(content);
      const variantId = variantIdFromInstructionsSha256(fullHash);
      const route = variantSketchRoute(variantId);
      const shard = readGzipShard(await readFile(path.join(outDir, "variants", "sketches", route.directory, `${route.file}.json.gz`))) as Record<string, { instructionsSha256: string; sketch: string[] }>;
      expect(shard[variantId]).toEqual({
        instructionsSha256: fullHash,
        sketch: instructionSketch(normalizeInstructions(content)),
      });
    }
  });

  it("skips missing representative content and excludes lowercase skill.md", async () => {
    const { outDir } = await buildFixture();
    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8")) as {
      instructionIndex: { skippedDistinctContentCount: number };
    };
    expect(manifest.instructionIndex.skippedDistinctContentCount).toBeGreaterThan(0);
    const lowercaseShard = readGzipShard(await readFile(path.join(outDir, "exact", "ee.json.gz")));
    expect(lowercaseShard).not.toHaveProperty("ee" + "0".repeat(38));
  });
});

describe("variant anchors", () => {
  it("keeps unchanged anchors in SHA-256-routed two-hex shards", async () => {
    const content = "one two three four five six seven eight nine ten eleven twelve\n";
    const fixture: TestFixture = {
      repos: [{ full_name: "routing/repo", stars: 1 }],
      artifacts: [{ file_sha: SHA_A, repo_full_name: "routing/repo", path: "SKILL.md", content }],
    };
    const { outDir } = await buildFixture(fixture);
    const variantId = variantIdFromInstructionsSha256(instrSha256(content));
    for (const anchor of instructionSketch(normalizeInstructions(content)).slice(0, 8)) {
      const shard = readGzipShard(await readFile(path.join(outDir, "variants", "anchors", `${anchorShardPrefix(anchor)}.json.gz`)));
      expect(shard[anchor]).toContain(variantId);
    }
  });

  it("omits hot anchors and reports their count", async () => {
    const artifacts = Array.from({ length: 2001 }, (_, index) => ({
      file_sha: (index + 1).toString(16).padStart(40, "0"),
      repo_full_name: "hot/repo",
      path: `skills/${index}/SKILL.md`,
      content: `common one two three four unique-${index}\n`,
    }));
    const { outDir } = await buildFixture({ repos: [{ full_name: "hot/repo", stars: 1 }], artifacts });
    const anchor = shingleHash96("common one two three four");
    const shard = readGzipShard(await readFile(path.join(outDir, "variants", "anchors", `${anchorShardPrefix(anchor)}.json.gz`)));
    expect(shard).not.toHaveProperty(anchor);
    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8")) as { variantIndex: { skippedHotAnchorCount: number } };
    expect(manifest.variantIndex.skippedHotAnchorCount).toBe(1);
  });
});

describe("index safety and determinism", () => {
  it("contains no source Skill text in variant index files", async () => {
    const marker = "SECRET-SOURCE-MARKER";
    const { outDir } = await buildFixture({
      repos: [{ full_name: "safe/repo", stars: 1 }],
      artifacts: [{
        file_sha: SHA_A,
        repo_full_name: "safe/repo",
        path: "SKILL.md",
        content: `# ${marker}\none two three four five six\n`,
      }],
    });
    for (const relative of ["variants/sketches", "variants/anchors"]) {
      for (const file of await filesRecursively(path.join(outDir, relative))) {
        expect(gunzipSync(await readFile(file)).toString("utf-8")).not.toContain(marker);
      }
    }
  });

  it("produces byte-identical nested sketch layout and gzip output", async () => {
    const tmpDir = await makeTempDir();
    const dbPath = path.join(tmpDir, "test.db");
    const first = path.join(tmpDir, "index-a");
    const second = path.join(tmpDir, "index-b");
    await createTestDb(dbPath, FIXTURE);
    await runBuilder(dbPath, first);
    await runBuilder(dbPath, second);

    const firstRoot = path.join(first, "variants", "sketches");
    const secondRoot = path.join(second, "variants", "sketches");
    const firstFiles = (await filesRecursively(firstRoot)).map((file) => path.relative(firstRoot, file).replaceAll("\\", "/"));
    const secondFiles = (await filesRecursively(secondRoot)).map((file) => path.relative(secondRoot, file).replaceAll("\\", "/"));
    expect(firstFiles).toEqual(secondFiles);
    for (const relative of firstFiles) {
      expect((await readFile(path.join(firstRoot, relative))).equals(await readFile(path.join(secondRoot, relative)))).toBe(true);
    }
  });
});
