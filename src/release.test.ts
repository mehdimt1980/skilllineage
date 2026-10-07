import { describe, it, expect } from "vitest";
import { readdir, readFile, mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

import * as skilllineage from "./index.js";
import { VERSION } from "./cli/app.js";
import { readManifest, IndexError } from "./index/index.js";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(__dirname, "..");
const mainCliPath = path.join(rootDir, "dist", "cli", "main.js");

const EXPECTED_RUNTIME_EXPORTS = [
  "FingerprintError",
  "IndexError",
  "TraceError",
  "VARIANT_ENRICHMENT_SHARD_ROUTING",
  "VARIANT_SKETCH_SHARD_ROUTING",
  "VERSION",
  "compareSkills",
  "computeGitBlobSha1",
  "estimateSketchSimilarity",
  "fingerprint",
  "instructionSimilarity",
  "instructionSketch",
  "lookupExact",
  "lookupInstructions",
  "normalizeInstructions",
  "readAnchorShard",
  "readInstructionShard",
  "readManifest",
  "readShard",
  "readSketchShard",
  "readVariantEnrichmentShard",
  "shardPrefix",
  "shingleHash96",
  "traceSkill",
  "variantEnrichmentRoute",
  "variantIdFromInstructionsSha256",
  "variantSketchRoute",
].sort();

describe("Release Hardening & Package Invariants", () => {
  describe("Public API Freeze", () => {
    it("exports exactly the frozen set of runtime symbols from root index", () => {
      const actualExports = Object.keys(skilllineage).sort();
      expect(actualExports).toEqual(EXPECTED_RUNTIME_EXPORTS);
    });

    it("preserves public error classes as subclasses of Error", () => {
      expect(new skilllineage.FingerprintError("test")).toBeInstanceOf(Error);
      expect(new skilllineage.IndexError("test")).toBeInstanceOf(Error);
      expect(new skilllineage.TraceError("test")).toBeInstanceOf(Error);
    });
  });

  describe("Version Consistency", () => {
    it("maintains version 0.1.0 across package.json and exported VERSION", async () => {
      const pkgJsonRaw = await readFile(path.join(rootDir, "package.json"), "utf-8");
      const pkg = JSON.parse(pkgJsonRaw) as { version: string };
      expect(pkg.version).toBe("0.1.0");
      expect(VERSION).toBe("0.1.0");
      expect(skilllineage.VERSION).toBe("0.1.0");
    });
  });

  describe("Production Build Artifact Audit", () => {
    async function collectFiles(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await collectFiles(fullPath)));
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
      return files;
    }

    it("ensures dist directory contains no test or spec artifacts", async () => {
      const distDir = path.join(rootDir, "dist");
      const files = await collectFiles(distDir);
      expect(files.length).toBeGreaterThan(0);

      const forbiddenSuffixes = [
        ".test.js",
        ".test.d.ts",
        ".test.js.map",
        ".test.d.ts.map",
        ".spec.js",
        ".spec.d.ts",
        ".spec.js.map",
        ".spec.d.ts.map",
      ];

      for (const file of files) {
        const rel = path.relative(distDir, file).replace(/\\/g, "/");
        for (const suffix of forbiddenSuffixes) {
          expect(rel.endsWith(suffix)).toBe(false);
        }
        expect(rel.includes("__tests__")).toBe(false);
      }
    });
  });

  describe("CLI Process Execution", () => {
    async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [mainCliPath, ...args]);
        return { stdout, stderr, exitCode: 0 };
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: execErr.stdout ?? "",
          stderr: execErr.stderr ?? "",
          exitCode: execErr.code ?? 1,
        };
      }
    }

    it("outputs version to stdout with exit code 0", async () => {
      const res = await runCli(["--version"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("0.1.0");
      expect(res.stderr).toBe("");
    });

    it("outputs help to stdout with exit code 0 for --help", async () => {
      const res = await runCli(["--help"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("USAGE");
      expect(res.stderr).toBe("");
    });

    it("outputs help to stdout with exit code 0 when called without args", async () => {
      const res = await runCli([]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("USAGE");
      expect(res.stderr).toBe("");
    });

    it("rejects unknown command with non-zero exit and message on stderr", async () => {
      const res = await runCli(["nonsense"]);
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain('Unknown command "nonsense"');
    });

    it("emits invalid command arguments error to stderr only", async () => {
      const res = await runCli(["fingerprint"]);
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("Error: fingerprint requires a <path> argument.");
    });

    it("emits valid JSON report to stdout only on successful fingerprint command", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "skilllineage-cli-test-"));
      try {
        await writeFile(path.join(tmp, "SKILL.md"), "# Test Skill\nInstructions here.\n", "utf-8");
        const res = await runCli(["fingerprint", tmp]);
        expect(res.exitCode).toBe(0);
        expect(res.stderr).toBe("");
        const parsed = JSON.parse(res.stdout) as { schemaVersion: string; fingerprints: { gitBlobSha1: string } };
        expect(parsed.schemaVersion).toBe("0.1");
        expect(parsed.fingerprints.gitBlobSha1).toMatch(/^sha1:[0-9a-f]{40}$/);
      } finally {
        await readdir(tmp).catch(() => []);
      }
    });
  });

  describe("Incompatible Index Schema Rejection", () => {
    it("rejects schema 0.4 index with explicit rebuild instructions", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "skilllineage-schema-test-"));
      try {
        const manifest = {
          schemaVersion: "0.4",
          kind: "skilllineage-exact-index",
          source: { name: "Test", snapshot: "2026-01", license: "MIT", url: "https://example.com" },
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
            enrichment: {
              algorithm: "precomputed-variant-summary-v1",
              shardRouting: "instructions-sha256-hex4-v1",
              exampleLimit: 3,
            },
            skippedHotAnchorCount: 0,
          },
        };
        await writeFile(path.join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
        await expect(readManifest(tmp)).rejects.toThrow(IndexError);
        await expect(readManifest(tmp)).rejects.toThrow("Unsupported schema version: 0.4. Rebuild the index with the current builder.");
      } finally {
        await readdir(tmp).catch(() => []);
      }
    });
  });
});
