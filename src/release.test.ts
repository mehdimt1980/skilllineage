import { describe, it, expect } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as skilllineage from "./index.js";
import { VERSION } from "./cli/app.js";
import { readManifest, IndexError } from "./index/index.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
      expect(Object.keys(skilllineage).sort()).toEqual(EXPECTED_RUNTIME_EXPORTS);
    });

    it("preserves public error classes as subclasses of Error", () => {
      expect(new skilllineage.FingerprintError("test")).toBeInstanceOf(Error);
      expect(new skilllineage.IndexError("test")).toBeInstanceOf(Error);
      expect(new skilllineage.TraceError("test")).toBeInstanceOf(Error);
    });

    it("accepts Uint8Array in the public Git blob hashing API without changing Buffer behavior", () => {
      const bytes = new Uint8Array([0x61, 0x62, 0x63]);
      const fromUint8Array = skilllineage.computeGitBlobSha1(bytes);
      const fromBuffer = skilllineage.computeGitBlobSha1(Buffer.from(bytes));
      expect(fromUint8Array).toBe(fromBuffer);
      expect(fromUint8Array).toMatch(/^sha1:[0-9a-f]{40}$/);
    });
  });

  describe("Version Consistency", () => {
    it("keeps package, lockfile root, and exported versions aligned at the v1.0.0 release candidate version", async () => {
      const pkg = JSON.parse(
        await readFile(path.join(rootDir, "package.json"), "utf-8"),
      ) as { version: string };
      const lock = JSON.parse(
        await readFile(path.join(rootDir, "package-lock.json"), "utf-8"),
      ) as {
        version: string;
        packages?: Record<string, { version?: string }>;
      };

      expect(pkg.version).toBe("1.0.0");
      expect(lock.version).toBe(pkg.version);
      expect(lock.packages?.[""]?.version).toBe(pkg.version);
      expect(VERSION).toBe(pkg.version);
      expect(skilllineage.VERSION).toBe(pkg.version);
    });
  });

  describe("Incompatible Index Schema Rejection", () => {
    it("rejects schema 0.4 index with explicit rebuild instructions", async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "skilllineage-schema-test-"));
      try {
        const manifest = {
          schemaVersion: "0.4",
          kind: "skilllineage-exact-index",
          source: {
            name: "Test",
            snapshot: "2026-01",
            license: "MIT",
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
        };
        await writeFile(
          path.join(tmp, "manifest.json"),
          JSON.stringify(manifest, null, 2),
          "utf-8",
        );
        await expect(readManifest(tmp)).rejects.toThrow(IndexError);
        await expect(readManifest(tmp)).rejects.toThrow(
          "Unsupported schema version: 0.4. Rebuild the index with the current builder.",
        );
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
