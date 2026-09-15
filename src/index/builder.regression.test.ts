import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";

import { normalizeInstructions } from "../fingerprint/index.js";
import { instructionSketch, variantIdFromInstructionsSha256 } from "../variant/index.js";
import { variantSketchRoute } from "./routing.js";

const execFileAsync = promisify(execFile);
const BUILDER_PATH = path.resolve("tools/build-gitskills-index.py");
const DB_CREATOR_PATH = path.resolve("tools/create-test-db.py");
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skilllineage-builder-regression-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

interface Artifact {
  file_sha: string;
  repo_full_name: string;
  path: string;
  content: string | null;
  location_class?: string | null;
  first_commit_at?: string | null;
  last_commit_at?: string | null;
  history_fetched?: number | null;
}

async function build(
  artifacts: Artifact[],
  repos: Array<{ full_name: string; stars?: number }> = [{ full_name: "test/repo", stars: 1 }],
): Promise<string> {
  const root = await makeTempDir();
  const dbPath = path.join(root, "test.db");
  const fixturePath = `${dbPath}.fixture.json`;
  const outDir = path.join(root, "index");
  await writeFile(fixturePath, JSON.stringify({ repos, artifacts }), "utf-8");
  await execFileAsync("python", [DB_CREATOR_PATH, dbPath, fixturePath]);
  await execFileAsync("python", [BUILDER_PATH, dbPath, outDir, "--source-snapshot", "2026-07"]);
  return outDir;
}

function instructionHash(content: string): string {
  return createHash("sha256")
    .update(Buffer.from(normalizeInstructions(content), "utf-8"))
    .digest("hex");
}

function parseGzip(buffer: Buffer): Record<string, unknown> {
  return JSON.parse(gunzipSync(buffer).toString("utf-8")) as Record<string, unknown>;
}

async function readSketchRecord(outDir: string, content: string): Promise<unknown> {
  const fullHash = instructionHash(content);
  const variantId = variantIdFromInstructionsSha256(fullHash);
  const route = variantSketchRoute(variantId);
  const shard = parseGzip(await readFile(path.join(
    outDir,
    "variants",
    "sketches",
    route.directory,
    `${route.file}.json.gz`,
  )));
  return shard[variantId];
}

describe("builder regression coverage", () => {
  it("preserves normalization and sketch parity for CRLF, BOM, trailing whitespace, and empty bodies", async () => {
    const cases = [
      "one two three four five six\r\n",
      "\uFEFFone two three four five six\n",
      "one two three four five six   \n",
      "---\nname: empty\n---\n",
    ];
    const outDir = await build(cases.map((content, index) => ({
      file_sha: (index + 1).toString(16).padStart(40, "0"),
      repo_full_name: "test/repo",
      path: `skills/${index}/SKILL.md`,
      content,
    })));

    for (const content of cases) {
      expect(await readSketchRecord(outDir, content)).toEqual({
        instructionsSha256: instructionHash(content),
        sketch: instructionSketch(normalizeInstructions(content)),
      });
    }
  });

  it("keeps exact duplicate occurrence aggregation and explicit nullable metadata", async () => {
    const hash = "ab12345678901234567890123456789012345678";
    const content = "# Skill\none two three four five six\n";
    const outDir = await build([
      {
        file_sha: hash,
        repo_full_name: "alpha/repo",
        path: "SKILL.md",
        content,
        location_class: null,
        first_commit_at: null,
        last_commit_at: null,
        history_fetched: null,
      },
      {
        file_sha: hash,
        repo_full_name: "beta/repo",
        path: "skills/SKILL.md",
        content,
        location_class: null,
        first_commit_at: null,
        last_commit_at: null,
        history_fetched: null,
      },
    ], [
      { full_name: "alpha/repo", stars: 3 },
      { full_name: "beta/repo", stars: 4 },
    ]);

    const shard = parseGzip(await readFile(path.join(outDir, "exact", "ab.json.gz"))) as Record<
      string,
      { copyCount: number; occurrences: Array<Record<string, unknown>> }
    >;
    expect(shard[hash].copyCount).toBe(2);
    expect(shard[hash].occurrences).toHaveLength(2);
    for (const occurrence of shard[hash].occurrences) {
      expect(occurrence).toHaveProperty("locationClass", null);
      expect(occurrence).toHaveProperty("firstCommitAt", null);
      expect(occurrence).toHaveProperty("lastCommitAt", null);
      expect(occurrence).toHaveProperty("historyFetched", null);
    }
  });

  it("keeps exact and instruction shard gzip output deterministic across builds", async () => {
    const content = "# Skill\none two three four five six seven eight\n";
    const artifacts = [{
      file_sha: "aa" + "0".repeat(38),
      repo_full_name: "test/repo",
      path: "SKILL.md",
      content,
    }];
    const first = await build(artifacts);
    const second = await build(artifacts);

    for (const relative of ["exact", "instructions", "variants/anchors"]) {
      const firstFiles = (await readdir(path.join(first, relative))).sort();
      const secondFiles = (await readdir(path.join(second, relative))).sort();
      expect(firstFiles).toEqual(secondFiles);
      for (const file of firstFiles) {
        expect((await readFile(path.join(first, relative, file))).equals(
          await readFile(path.join(second, relative, file)),
        )).toBe(true);
      }
    }
  });
});
