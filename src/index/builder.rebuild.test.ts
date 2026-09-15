import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const BUILDER_PATH = path.resolve("tools/build-gitskills-index.py");
const DB_CREATOR_PATH = path.resolve("tools/create-test-db.py");
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("schema 0.3 sketch rebuild hygiene", () => {
  it("removes obsolete flat and stale nested sketch shards before rebuilding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skilllineage-rebuild-"));
    tempDirs.push(root);
    const dbPath = path.join(root, "test.db");
    const fixturePath = `${dbPath}.fixture.json`;
    const outDir = path.join(root, "index");
    const sketchRoot = path.join(outDir, "variants", "sketches");

    await writeFile(fixturePath, JSON.stringify({
      repos: [{ full_name: "test/repo", stars: 1 }],
      artifacts: [{
        file_sha: "aa" + "0".repeat(38),
        repo_full_name: "test/repo",
        path: "SKILL.md",
        content: "one two three four five six seven eight\n",
      }],
    }), "utf-8");
    await execFileAsync("python", [DB_CREATOR_PATH, dbPath, fixturePath]);

    await mkdir(path.join(sketchRoot, "fe"), { recursive: true });
    await writeFile(path.join(sketchRoot, "aa.json.gz"), "obsolete-flat-layout", "utf-8");
    await writeFile(path.join(sketchRoot, "fe", "ed.json.gz"), "stale-nested-layout", "utf-8");

    await execFileAsync("python", [BUILDER_PATH, dbPath, outDir, "--source-snapshot", "2026-07"]);

    await expect(readFile(path.join(sketchRoot, "aa.json.gz"))).rejects.toThrow();
    await expect(readFile(path.join(sketchRoot, "fe", "ed.json.gz"))).rejects.toThrow();
    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8")) as {
      schemaVersion: string;
      variantIndex: { sketchShardRouting: string };
    };
    expect(manifest.schemaVersion).toBe("0.3");
    expect(manifest.variantIndex.sketchShardRouting).toBe("variant-id-hex4-v1");
  });
});
