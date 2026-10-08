import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";

import { traceSkill } from "./trace.js";
import { computeGitBlobSha1, normalizeInstructions } from "../fingerprint/index.js";
import type {
  IndexManifest,
  IndexShard,
  InstructionShard,
  SketchShard,
  AnchorShard,
  VariantEnrichmentShard,
  HistoryShard,
} from "../index/types.js";
import {
  variantEnrichmentRoute,
  variantSketchRoute,
  exactHistoryRoute,
  instructionHistoryRoute,
} from "../index/routing.js";
import {
  anchorShardPrefix,
  instructionSketch,
  variantIdFromInstructionsSha256,
} from "../variant/index.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skilllineage-regression-"));
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
    schemaVersion: "0.5",
    kind: "skilllineage-exact-index",
    source: {
      name: "RegressionTestSkills",
      snapshot: "2026-10",
      license: "CC-BY-4.0",
      url: "https://example.com/skills",
    },
    indexes: {
      exact: { algorithm: "git-blob-sha1", shardPrefixLength: 2 },
      instructions: {
        algorithm: "normalized-instructions-sha256",
        shardPrefixLength: 2,
      },
    },
    recordCount: 10,
    distinctHashCount: 8,
    instructionIndex: {
      indexedDistinctContentCount: 6,
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
  };
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
}

function instrHex(content: string): string {
  return sha256Hex(normalizeInstructions(content));
}

interface TestIndex {
  exactShards?: Record<string, IndexShard>;
  instrShards?: Record<string, InstructionShard>;
  sketchShards?: Record<string, SketchShard>;
  anchorShards?: Record<string, AnchorShard>;
  enrichmentShards?: Record<string, VariantEnrichmentShard>;
  exactHistoryShards?: Record<string, HistoryShard>;
  instructionHistoryShards?: Record<string, HistoryShard>;
  manifest?: IndexManifest;
}

async function writeGzip(filePath: string, data: object): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, gzipSync(Buffer.from(JSON.stringify(data), "utf-8")));
}

async function makeIndex(opts: TestIndex = {}): Promise<string> {
  const dir = await makeTempDir();
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(opts.manifest ?? validManifest(), null, 2),
    "utf-8",
  );

  for (let i = 0; i < 256; i++) {
    const pfx = i.toString(16).padStart(2, "0");
    await writeGzip(
      path.join(dir, "exact", `${pfx}.json.gz`),
      opts.exactShards?.[pfx] ?? {},
    );
    await writeGzip(
      path.join(dir, "instructions", `${pfx}.json.gz`),
      opts.instrShards?.[pfx] ?? {},
    );
    await writeGzip(
      path.join(dir, "variants", "anchors", `${pfx}.json.gz`),
      opts.anchorShards?.[pfx] ?? {},
    );
  }

  for (const [routeKey, shard] of Object.entries(opts.sketchShards ?? {})) {
    const [first, second] = routeKey.split("/");
    await writeGzip(
      path.join(dir, "variants", "sketches", first, `${second}.json.gz`),
      shard,
    );
  }
  for (const [routeKey, shard] of Object.entries(opts.enrichmentShards ?? {})) {
    const [first, second] = routeKey.split("/");
    await writeGzip(
      path.join(dir, "variants", "enrichment", first, `${second}.json.gz`),
      shard,
    );
  }

  for (const [kind, shards] of [
    ["exact", opts.exactHistoryShards],
    ["instructions", opts.instructionHistoryShards],
  ] as const) {
    for (const [route, shard] of Object.entries(shards ?? {})) {
      const [first, second] = route.split("/");
      await writeGzip(path.join(dir, "history", kind, first, `${second}.json.gz`), shard);
    }
  }

  return dir;
}

const TOOL_VERSION = "1.0.0";

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Phase 13A Semantic Trace Evidence Regression Coverage", () => {
  describe("Match Type 1: exact", () => {
    it("produces deterministic report with history evidence and summary, preserving epistemic invariants", async () => {
      const skillContent = "---\nname: Alpha Skill\nauthor: Alice\n---\n# Instructions\nExecute deterministic steps.\n";
      const skillDir = await makeTempSkill({ "SKILL.md": skillContent });
      const rawBlobHash = computeGitBlobSha1(Buffer.from(skillContent)).replace(/^sha1:/, "");
      const instructionsSha256Hex = instrHex(skillContent);

      const exactHistoryRecord = {
        totalLocationCount: 2,
        historyFetchedLocationCount: 2,
        usableLocationCount: 2,
        chronologyAnomalyCount: 0,
        conflictingLocationCount: 0,
        coverage: "complete" as const,
        earliestObserved: {
          repoFullName: "upstream/skills",
          path: ".agent/skills/alpha/SKILL.md",
          firstCommitAt: "2026-01-15T08:30:00.000000Z",
          lastCommitAt: "2026-03-20T14:00:00.000000Z",
        },
        latestObserved: {
          repoFullName: "fork/skills",
          path: "skills/alpha/SKILL.md",
          firstCommitAt: "2026-02-10T11:00:00.000000Z",
          lastCommitAt: "2026-04-01T09:15:00.000000Z",
        },
      };

      const occurrenceA = {
        repoFullName: "upstream/skills",
        path: ".agent/skills/alpha/SKILL.md",
        locationClass: "canonical",
        stars: 120,
        firstCommitAt: "2026-01-15T08:30:00Z",
        lastCommitAt: "2026-03-20T14:00:00Z",
        historyFetched: true,
      };
      const occurrenceB = {
        repoFullName: "fork/skills",
        path: "skills/alpha/SKILL.md",
        locationClass: null,
        stars: 12,
        firstCommitAt: "2026-02-10T11:00:00Z",
        lastCommitAt: "2026-04-01T09:15:00Z",
        historyFetched: true,
      };

      const indexDir = await makeIndex({
        exactShards: {
          [rawBlobHash.slice(0, 2)]: {
            [rawBlobHash]: {
              copyCount: 2,
              occurrences: [occurrenceA, occurrenceB],
            },
          },
        },
        exactHistoryShards: {
          [exactHistoryRoute(rawBlobHash).key]: {
            [rawBlobHash]: exactHistoryRecord,
          },
        },
      });

      const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

      expect(report.schemaVersion).toBe("0.5");
      expect(report.origin).toEqual({ status: "not_inferred" });
      expect(report.query).toEqual({
        gitBlobSha1: `sha1:${rawBlobHash}`,
        instructionsSha256: `sha256:${instructionsSha256Hex}`,
      });

      expect(report.match.type).toBe("exact");
      if (report.match.type !== "exact") return;

      expect(report.match.copyCount).toBe(2);
      expect(report.match.occurrences).toEqual([occurrenceA, occurrenceB]);
      expect(report.match.history).toEqual({
        status: "available",
        semantics: "observed_not_origin",
        ...exactHistoryRecord,
      });

      expect(report.match).not.toHaveProperty("temporalEvidence");
      expect(report.match).not.toHaveProperty("evidenceGraph");

      expect(report.evidenceSummary.semantics).toBe("derived_from_trace_evidence_only");
      expect(report.evidenceSummary.headline).toBe("Exact content match found in 2 indexed occurrences.");
      expect(report.evidenceSummary.facts).toEqual([
        {
          code: "match",
          text: "Exact content match found in 2 indexed occurrences.",
        },
        {
          code: "history_coverage",
          text: "Stored history coverage is complete: 2 of 2 indexed locations have usable historical observations.",
        },
        {
          code: "earliest_observed",
          text: "Earliest usable observation in the indexed dataset is 2026-01-15T08:30:00.000000Z at upstream/skills/.agent/skills/alpha/SKILL.md.",
        },
      ]);
      expect(report.evidenceSummary.limitations).toEqual([
        {
          code: "origin_not_inferred",
          text: "SkillLineage does not infer an origin repository or original author from this evidence.",
        },
        {
          code: "dataset_observation_only",
          text: "Historical timestamps describe observations in the indexed dataset, not when a Skill first existed outside the dataset.",
        },
      ]);
    });

    it("handles missing stored history with appropriate facts and limitations", async () => {
      const skillContent = "---\nname: Gamma Skill\n---\n# Instructions\nExecute without history.\n";
      const skillDir = await makeTempSkill({ "SKILL.md": skillContent });
      const rawBlobHash = computeGitBlobSha1(Buffer.from(skillContent)).replace(/^sha1:/, "");

      const occurrence = {
        repoFullName: "solo/gamma",
        path: "skills/gamma/SKILL.md",
        locationClass: null,
        stars: 1,
        firstCommitAt: null,
        lastCommitAt: null,
        historyFetched: false,
      };

      const indexDir = await makeIndex({
        exactShards: {
          [rawBlobHash.slice(0, 2)]: {
            [rawBlobHash]: {
              copyCount: 1,
              occurrences: [occurrence],
            },
          },
        },
      });

      const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);
      expect(report.match.type).toBe("exact");
      if (report.match.type !== "exact") return;

      expect(report.match.history).toEqual({
        status: "not_available",
        semantics: "observed_not_origin",
        reason: "no_stored_history",
      });
      expect(report.evidenceSummary.limitations).toEqual([
        {
          code: "origin_not_inferred",
          text: "SkillLineage does not infer an origin repository or original author from this evidence.",
        },
        {
          code: "history_unavailable",
          text: "Stored historical evidence is not available for this match.",
        },
      ]);
    });
  });

  describe("Match Type 2: same_instructions", () => {
    it("produces deterministic report when instructions match but raw bytes differ", async () => {
      const indexedOriginal = "---\nname: Beta Skill\nversion: 1.0\n---\n# Instructions\nPerform task with precision.\n";
      const localQuery = "---\nname: Beta Skill Fork\nversion: 2.0\nauthor: Charlie\n---\n# Instructions\nPerform task with precision.\n";

      const indexedBlobHash = computeGitBlobSha1(Buffer.from(indexedOriginal)).replace(/^sha1:/, "");
      const instructionsSha256Hex = instrHex(localQuery);
      expect(instrHex(indexedOriginal)).toBe(instructionsSha256Hex);

      const skillDir = await makeTempSkill({ "SKILL.md": localQuery });

      const instructionHistoryRecord = {
        totalLocationCount: 3,
        historyFetchedLocationCount: 2,
        usableLocationCount: 2,
        chronologyAnomalyCount: 0,
        conflictingLocationCount: 0,
        coverage: "partial" as const,
        earliestObserved: {
          repoFullName: "beta-org/core-skills",
          path: "skills/beta/SKILL.md",
          firstCommitAt: "2026-02-01T09:00:00.000000Z",
          lastCommitAt: "2026-05-10T16:00:00.000000Z",
        },
        latestObserved: {
          repoFullName: "beta-org/mirror-skills",
          path: "skills/beta/SKILL.md",
          firstCommitAt: "2026-03-01T12:00:00.000000Z",
          lastCommitAt: "2026-05-10T16:00:00.000000Z",
        },
      };

      const occurrence1 = {
        repoFullName: "beta-org/core-skills",
        path: "skills/beta/SKILL.md",
        locationClass: "canonical",
        stars: 55,
        firstCommitAt: "2026-02-01T09:00:00Z",
        lastCommitAt: "2026-05-10T16:00:00Z",
        historyFetched: true,
      };
      const occurrence2 = {
        repoFullName: "beta-org/mirror-skills",
        path: "skills/beta/SKILL.md",
        locationClass: null,
        stars: 10,
        firstCommitAt: "2026-03-01T12:00:00Z",
        lastCommitAt: "2026-05-10T16:00:00Z",
        historyFetched: true,
      };

      const indexDir = await makeIndex({
        exactShards: {
          [indexedBlobHash.slice(0, 2)]: {
            [indexedBlobHash]: {
              copyCount: 2,
              occurrences: [occurrence1, occurrence2],
            },
          },
        },
        instrShards: {
          [instructionsSha256Hex.slice(0, 2)]: {
            [instructionsSha256Hex]: [indexedBlobHash],
          },
        },
        instructionHistoryShards: {
          [instructionHistoryRoute(instructionsSha256Hex).key]: {
            [instructionsSha256Hex]: instructionHistoryRecord,
          },
        },
      });

      const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

      expect(report.schemaVersion).toBe("0.5");
      expect(report.origin).toEqual({ status: "not_inferred" });
      expect(report.match.type).toBe("same_instructions");
      if (report.match.type !== "same_instructions") return;

      expect(report.match.rawVariantCount).toBe(1);
      expect(report.match.copyCount).toBe(2);
      expect(report.match.contentHashes).toEqual([`sha1:${indexedBlobHash}`]);
      expect(report.match.occurrences).toEqual([occurrence1, occurrence2]);
      expect(report.match.history).toEqual({
        status: "available",
        semantics: "observed_not_origin",
        ...instructionHistoryRecord,
      });

      expect(report.match).not.toHaveProperty("temporalEvidence");
      expect(report.match).not.toHaveProperty("evidenceGraph");

      expect(report.evidenceSummary.semantics).toBe("derived_from_trace_evidence_only");
      expect(report.evidenceSummary.headline).toBe(
        "Normalized instructions match found across 1 raw content variant and 2 indexed occurrences.",
      );
      expect(report.evidenceSummary.facts).toEqual([
        {
          code: "match",
          text: "Normalized instructions match found across 1 raw content variant and 2 indexed occurrences.",
        },
        {
          code: "history_coverage",
          text: "Stored history coverage is partial: 2 of 3 indexed locations have usable historical observations.",
        },
        {
          code: "earliest_observed",
          text: "Earliest usable observation in the indexed dataset is 2026-02-01T09:00:00.000000Z at beta-org/core-skills/skills/beta/SKILL.md.",
        },
      ]);
      expect(report.evidenceSummary.limitations).toEqual([
        {
          code: "origin_not_inferred",
          text: "SkillLineage does not infer an origin repository or original author from this evidence.",
        },
        {
          code: "dataset_observation_only",
          text: "Historical timestamps describe observations in the indexed dataset, not when a Skill first existed outside the dataset.",
        },
        {
          code: "history_incomplete",
          text: "Historical coverage is partial; additional or earlier observations may exist outside the stored evidence.",
        },
      ]);
    });

    it("handles empty normalized instructions with empty_normalized_instructions reason", async () => {
      const indexedOriginal = "---\nname: Empty Instructions A\n---\n";
      const localQuery = "---\nname: Empty Instructions B\n---\n";

      const indexedBlobHash = computeGitBlobSha1(Buffer.from(indexedOriginal)).replace(/^sha1:/, "");
      const instructionsSha256Hex = instrHex(localQuery);

      const skillDir = await makeTempSkill({ "SKILL.md": localQuery });

      const indexDir = await makeIndex({
        exactShards: {
          [indexedBlobHash.slice(0, 2)]: {
            [indexedBlobHash]: {
              copyCount: 1,
              occurrences: [
                {
                  repoFullName: "org/empty",
                  path: "SKILL.md",
                  locationClass: null,
                  stars: 0,
                  firstCommitAt: null,
                  lastCommitAt: null,
                  historyFetched: null,
                },
              ],
            },
          },
        },
        instrShards: {
          [instructionsSha256Hex.slice(0, 2)]: {
            [instructionsSha256Hex]: [indexedBlobHash],
          },
        },
      });

      const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);
      expect(report.match.type).toBe("same_instructions");
      if (report.match.type !== "same_instructions") return;

      expect(report.match.history).toEqual({
        status: "not_available",
        semantics: "observed_not_origin",
        reason: "empty_normalized_instructions",
      });
      expect(report.evidenceSummary.limitations).toEqual([
        {
          code: "origin_not_inferred",
          text: "SkillLineage does not infer an origin repository or original author from this evidence.",
        },
        {
          code: "history_unavailable",
          text: "Stored historical evidence is not available for this match.",
        },
      ]);
    });
  });

  describe("Match Type 3: variant_candidates", () => {
    it("produces complete deterministic variant payloads with ranking, temporal evidence, and evidence graph", async () => {
      const sharedBase = Array.from({ length: 40 }, (_, i) => `instruction step token number ${i} for processing data`).join("\n");
      const queryContent = `# Query Skill\n${sharedBase}\nspecific query step additional tokens\n`;
      const cand1Content = `# Candidate One\n${sharedBase}\nspecific candidate one steps additional tokens\n`;
      const cand2Content = `# Candidate Two\n${sharedBase}\nspecific candidate two modified branch tokens\n`;

      const queryDir = await makeTempSkill({ "SKILL.md": queryContent });

      const queryNormalized = normalizeInstructions(queryContent);
      const cand1Normalized = normalizeInstructions(cand1Content);
      const cand2Normalized = normalizeInstructions(cand2Content);

      const querySketch = instructionSketch(queryNormalized);
      const cand1Sketch = instructionSketch(cand1Normalized);
      const cand2Sketch = instructionSketch(cand2Normalized);

      const cand1InstrHex = instrHex(cand1Content);
      const cand2InstrHex = instrHex(cand2Content);

      const cand1VarId = variantIdFromInstructionsSha256(cand1InstrHex);
      const cand2VarId = variantIdFromInstructionsSha256(cand2InstrHex);

      const queryAnchors = querySketch.slice(0, 8);
      const cand1Anchors = cand1Sketch.slice(0, 8);
      const cand2Anchors = cand2Sketch.slice(0, 8);

      const anchorShards: Record<string, AnchorShard> = {};
      for (const anchor of cand1Anchors) {
        if (queryAnchors.includes(anchor)) {
          const pfx = anchorShardPrefix(anchor);
          anchorShards[pfx] = anchorShards[pfx] ?? {};
          anchorShards[pfx][anchor] = anchorShards[pfx][anchor] ?? [];
          if (!anchorShards[pfx][anchor].includes(cand1VarId)) {
            anchorShards[pfx][anchor].push(cand1VarId);
          }
        }
      }
      for (const anchor of cand2Anchors) {
        if (queryAnchors.includes(anchor)) {
          const pfx = anchorShardPrefix(anchor);
          anchorShards[pfx] = anchorShards[pfx] ?? {};
          anchorShards[pfx][anchor] = anchorShards[pfx][anchor] ?? [];
          if (!anchorShards[pfx][anchor].includes(cand2VarId)) {
            anchorShards[pfx][anchor].push(cand2VarId);
          }
        }
      }

      const sketchShards: Record<string, SketchShard> = {
        [variantSketchRoute(cand1VarId).key]: {
          [cand1VarId]: {
            instructionsSha256: cand1InstrHex,
            sketch: cand1Sketch,
          },
        },
        [variantSketchRoute(cand2VarId).key]: {
          [cand2VarId]: {
            instructionsSha256: cand2InstrHex,
            sketch: cand2Sketch,
          },
        },
      };

      const cand1Enrichment = {
        rawVariantCount: 2,
        copyCount: 5,
        examples: [
          { repoFullName: "org-a/skills", path: "skills/a/SKILL.md", stars: 200 },
          { repoFullName: "org-b/skills", path: "skills/b/SKILL.md", stars: 50 },
        ],
      };
      const cand2Enrichment = {
        rawVariantCount: 1,
        copyCount: 1,
        examples: [
          { repoFullName: "org-c/skills", path: "skills/c/SKILL.md", stars: 15 },
        ],
      };

      const enrichmentShards: Record<string, VariantEnrichmentShard> = {
        [variantEnrichmentRoute(cand1InstrHex).key]: {
          [cand1InstrHex]: cand1Enrichment,
        },
        [variantEnrichmentRoute(cand2InstrHex).key]: {
          [cand2InstrHex]: cand2Enrichment,
        },
      };

      const cand1History = {
        totalLocationCount: 2,
        historyFetchedLocationCount: 2,
        usableLocationCount: 2,
        chronologyAnomalyCount: 0,
        conflictingLocationCount: 0,
        coverage: "complete" as const,
        earliestObserved: {
          repoFullName: "org-a/skills",
          path: "skills/a/SKILL.md",
          firstCommitAt: "2026-01-05T10:00:00.000000Z",
          lastCommitAt: "2026-03-01T12:00:00.000000Z",
        },
        latestObserved: {
          repoFullName: "org-b/skills",
          path: "skills/b/SKILL.md",
          firstCommitAt: "2026-02-15T14:00:00.000000Z",
          lastCommitAt: "2026-03-01T12:00:00.000000Z",
        },
      };

      const cand2History = {
        totalLocationCount: 2,
        historyFetchedLocationCount: 1,
        usableLocationCount: 1,
        chronologyAnomalyCount: 0,
        conflictingLocationCount: 0,
        coverage: "partial" as const,
        earliestObserved: {
          repoFullName: "org-c/skills",
          path: "skills/c/SKILL.md",
          firstCommitAt: "2026-03-10T08:00:00.000000Z",
          lastCommitAt: "2026-04-01T10:00:00.000000Z",
        },
        latestObserved: {
          repoFullName: "org-c/skills",
          path: "skills/c/SKILL.md",
          firstCommitAt: "2026-03-10T08:00:00.000000Z",
          lastCommitAt: "2026-04-01T10:00:00.000000Z",
        },
      };

      const instructionHistoryShards: Record<string, HistoryShard> = {
        [instructionHistoryRoute(cand1InstrHex).key]: {
          [cand1InstrHex]: cand1History,
        },
        [instructionHistoryRoute(cand2InstrHex).key]: {
          [cand2InstrHex]: cand2History,
        },
      };

      const indexDir = await makeIndex({
        anchorShards,
        sketchShards,
        enrichmentShards,
        instructionHistoryShards,
      });

      const report = await traceSkill(queryDir, indexDir, TOOL_VERSION);

      expect(report.schemaVersion).toBe("0.5");
      expect(report.origin).toEqual({ status: "not_inferred" });
      expect(report.match.type).toBe("variant_candidates");
      if (report.match.type !== "variant_candidates") return;

      expect(report.match.method).toBe("bottom-k-token-shingles-v1");
      expect(report.match.approximate).toBe(true);
      expect(report.match.candidateGenerationTruncated).toBe(false);
      expect(report.match.candidates).toHaveLength(2);

      // Pin candidate identity, order, enrichment and observed histories to the
      // fixture data; deriving expected identities from traceSkill output would
      // allow a swapped or substituted candidate to escape this regression gate.
      expect(report.match.candidates).toMatchObject([
        {
          instructionsSha256: `sha256:${cand2InstrHex}`,
          rawVariantCount: cand2Enrichment.rawVariantCount,
          copyCount: cand2Enrichment.copyCount,
          examples: cand2Enrichment.examples,
          history: { status: "available", semantics: "observed_not_origin", ...cand2History },
        },
        {
          instructionsSha256: `sha256:${cand1InstrHex}`,
          rawVariantCount: cand1Enrichment.rawVariantCount,
          copyCount: cand1Enrichment.copyCount,
          examples: cand1Enrichment.examples,
          history: { status: "available", semantics: "observed_not_origin", ...cand1History },
        },
      ]);

      const firstCandidate = report.match.candidates[0];
      const secondCandidate = report.match.candidates[1];

      expect(firstCandidate.estimatedSimilarity).toBeGreaterThanOrEqual(secondCandidate.estimatedSimilarity);

      // Verify candidates contain full expected fields
      for (const candidate of report.match.candidates) {
        expect(candidate.instructionsSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(typeof candidate.estimatedSimilarity).toBe("number");
        expect(typeof candidate.sharedAnchors).toBe("number");
        expect(typeof candidate.rawVariantCount).toBe("number");
        expect(typeof candidate.copyCount).toBe("number");
        expect(Array.isArray(candidate.examples)).toBe(true);
        expect(candidate.history.status).toBe("available");
      }

      expect(firstCandidate.history.status).toBe("available");
      expect(secondCandidate.history.status).toBe("available");
      if (
        firstCandidate.history.status !== "available" ||
        secondCandidate.history.status !== "available" ||
        firstCandidate.history.earliestObserved === null ||
        secondCandidate.history.earliestObserved === null
      ) {
        throw new Error("Expected candidate history observations to be available");
      }

      // Verify temporal evidence payload
      expect(report.match.temporalEvidence).toEqual({
        status: "available",
        semantics: "dataset_observation_order_only",
        basis: "earliest_observed_first_commit_at",
        candidateCount: 2,
        totalPairCount: 1,
        comparablePairCount: 1,
        nonComparablePairCount: 0,
        relations: [
          {
            left: {
              instructionsSha256: firstCandidate.instructionsSha256,
              coverage: firstCandidate.history.coverage,
              earliestObserved: firstCandidate.history.earliestObserved,
            },
            right: {
              instructionsSha256: secondCandidate.instructionsSha256,
              coverage: secondCandidate.history.coverage,
              earliestObserved: secondCandidate.history.earliestObserved,
            },
            relation: "right_first_observed_before_left",
          },
        ],
      });

      // Verify evidence graph payload
      expect(report.match.evidenceGraph.semantics).toBe("evidence_links_not_lineage_direction");
      expect(report.match.evidenceGraph.queryNodeId).toBe("query");
      expect(report.match.evidenceGraph.nodeCount).toBe(3);
      expect(report.match.evidenceGraph.candidateNodeCount).toBe(2);
      expect(report.match.evidenceGraph.edgeCount).toBe(3);
      expect(report.match.evidenceGraph.similarityEdgeCount).toBe(2);
      expect(report.match.evidenceGraph.temporalObservationEdgeCount).toBe(1);

      expect(report.match.evidenceGraph.nodes).toEqual([
        {
          id: "query",
          kind: "query",
          instructionsSha256: `sha256:${instrHex(queryContent)}`,
        },
        {
          id: `candidate:${firstCandidate.instructionsSha256}`,
          kind: "variant_candidate",
          candidateIndex: 0,
          rank: 1,
          instructionsSha256: firstCandidate.instructionsSha256,
        },
        {
          id: `candidate:${secondCandidate.instructionsSha256}`,
          kind: "variant_candidate",
          candidateIndex: 1,
          rank: 2,
          instructionsSha256: secondCandidate.instructionsSha256,
        },
      ]);

      expect(report.match.evidenceGraph.edges).toEqual([
        {
          kind: "query_similarity",
          nodeIds: ["query", `candidate:${firstCandidate.instructionsSha256}`],
          approximate: true,
          method: "bottom-k-token-shingles-v1",
          estimatedSimilarity: firstCandidate.estimatedSimilarity,
          sharedAnchors: firstCandidate.sharedAnchors,
        },
        {
          kind: "query_similarity",
          nodeIds: ["query", `candidate:${secondCandidate.instructionsSha256}`],
          approximate: true,
          method: "bottom-k-token-shingles-v1",
          estimatedSimilarity: secondCandidate.estimatedSimilarity,
          sharedAnchors: secondCandidate.sharedAnchors,
        },
        {
          kind: "temporal_observation",
          nodeIds: [`candidate:${firstCandidate.instructionsSha256}`, `candidate:${secondCandidate.instructionsSha256}`],
          semantics: "dataset_observation_order_only",
          basis: "earliest_observed_first_commit_at",
          relation: "right_first_observed_before_left",
          leftCoverage: "partial",
          rightCoverage: "complete",
          leftFirstObservedAt: "2026-03-10T08:00:00.000000Z",
          rightFirstObservedAt: "2026-01-05T10:00:00.000000Z",
        },
      ]);

      // Verify evidence summary
      expect(report.evidenceSummary.semantics).toBe("derived_from_trace_evidence_only");
      expect(report.evidenceSummary.headline).toBe("2 approximate instruction variant candidates met the retrieval criteria.");
      expect(report.evidenceSummary.facts).toEqual([
        {
          code: "match",
          text: "2 approximate instruction variant candidates met the retrieval criteria.",
        },
        {
          code: "match",
          text: `Top-ranked candidate has estimated similarity ${firstCandidate.estimatedSimilarity} and ${firstCandidate.sharedAnchors} shared ${firstCandidate.sharedAnchors === 1 ? "anchor" : "anchors"}.`,
        },
        {
          code: "candidate_history",
          text: "Usable earliest-observation evidence is available for 2 of 2 final candidates.",
        },
        {
          code: "temporal_comparability",
          text: "1 of 1 candidate pair have comparable first-observation evidence in the indexed dataset.",
        },
        {
          code: "evidence_graph",
          text: "Evidence graph contains 2 candidate nodes, 2 query-similarity edges, and 1 temporal-observation edge.",
        },
      ]);
      expect(report.evidenceSummary.limitations).toEqual([
        {
          code: "approximate_similarity",
          text: "Variant similarity is approximate and is not evidence of copying, derivation, or common origin.",
        },
        {
          code: "origin_not_inferred",
          text: "SkillLineage does not infer an origin repository or original author from this evidence.",
        },
        {
          code: "dataset_observation_only",
          text: "Historical timestamps describe observations in the indexed dataset, not when a Skill first existed outside the dataset.",
        },
        {
          code: "history_incomplete",
          text: "At least one final candidate lacks complete usable historical coverage; temporal evidence may be incomplete.",
        },
      ]);
    });

    it("handles variant candidate with missing history rendering pair non-comparable", async () => {
      const sharedBase = Array.from({ length: 40 }, (_, i) => `instruction pairwise noncomparable test token ${i}`).join("\n");
      const queryContent = `# Query Skill\n${sharedBase}\nquery tail\n`;
      const cand1Content = `# Cand One\n${sharedBase}\ncand 1 tail\n`;
      const cand2Content = `# Cand Two\n${sharedBase}\ncand 2 tail\n`;

      const queryDir = await makeTempSkill({ "SKILL.md": queryContent });
      const querySketch = instructionSketch(normalizeInstructions(queryContent));
      const cand1Sketch = instructionSketch(normalizeInstructions(cand1Content));
      const cand2Sketch = instructionSketch(normalizeInstructions(cand2Content));

      const cand1InstrHex = instrHex(cand1Content);
      const cand2InstrHex = instrHex(cand2Content);

      const cand1VarId = variantIdFromInstructionsSha256(cand1InstrHex);
      const cand2VarId = variantIdFromInstructionsSha256(cand2InstrHex);

      const queryAnchors = querySketch.slice(0, 8);
      const anchorShards: Record<string, AnchorShard> = {};
      for (const anchor of cand1Sketch.slice(0, 8)) {
        if (queryAnchors.includes(anchor)) {
          const pfx = anchorShardPrefix(anchor);
          anchorShards[pfx] = anchorShards[pfx] ?? {};
          anchorShards[pfx][anchor] = [cand1VarId];
        }
      }
      for (const anchor of cand2Sketch.slice(0, 8)) {
        if (queryAnchors.includes(anchor)) {
          const pfx = anchorShardPrefix(anchor);
          anchorShards[pfx] = anchorShards[pfx] ?? {};
          const existing = anchorShards[pfx][anchor] ?? [];
          anchorShards[pfx][anchor] = [...existing, cand2VarId];
        }
      }

      const indexDir = await makeIndex({
        anchorShards,
        sketchShards: {
          [variantSketchRoute(cand1VarId).key]: {
            [cand1VarId]: {
              instructionsSha256: cand1InstrHex,
              sketch: cand1Sketch,
            },
          },
          [variantSketchRoute(cand2VarId).key]: {
            [cand2VarId]: {
              instructionsSha256: cand2InstrHex,
              sketch: cand2Sketch,
            },
          },
        },
        enrichmentShards: {
          [variantEnrichmentRoute(cand1InstrHex).key]: {
            [cand1InstrHex]: {
              rawVariantCount: 1,
              copyCount: 1,
              examples: [{ repoFullName: "org/one", path: "SKILL.md", stars: 5 }],
            },
          },
          [variantEnrichmentRoute(cand2InstrHex).key]: {
            [cand2InstrHex]: {
              rawVariantCount: 1,
              copyCount: 1,
              examples: [{ repoFullName: "org/two", path: "SKILL.md", stars: 10 }],
            },
          },
        },
        // Only cand1 has history, cand2 has no history
        instructionHistoryShards: {
          [instructionHistoryRoute(cand1InstrHex).key]: {
            [cand1InstrHex]: {
              totalLocationCount: 1,
              historyFetchedLocationCount: 1,
              usableLocationCount: 1,
              chronologyAnomalyCount: 0,
              conflictingLocationCount: 0,
              coverage: "complete",
              earliestObserved: {
                repoFullName: "org/one",
                path: "SKILL.md",
                firstCommitAt: "2026-01-01T00:00:00.000000Z",
                lastCommitAt: null,
              },
              latestObserved: {
                repoFullName: "org/one",
                path: "SKILL.md",
                firstCommitAt: "2026-01-01T00:00:00.000000Z",
                lastCommitAt: null,
              },
            },
          },
        },
      });

      const report = await traceSkill(queryDir, indexDir, TOOL_VERSION);
      expect(report.match.type).toBe("variant_candidates");
      if (report.match.type !== "variant_candidates") return;

      expect(report.match.temporalEvidence).toEqual({
        status: "not_available",
        semantics: "dataset_observation_order_only",
        basis: "earliest_observed_first_commit_at",
        reason: "insufficient_usable_history",
        candidateCount: 2,
        totalPairCount: 1,
        comparablePairCount: 0,
        nonComparablePairCount: 1,
        relations: [],
      });
      expect(report.match.evidenceGraph.temporalObservationEdgeCount).toBe(0);
      expect(report.evidenceSummary.facts.some((f) => f.code === "temporal_comparability" && f.text.includes("No final candidate pair has usable first-observation evidence"))).toBe(true);
    });

    it("handles single variant candidate with graceful temporal evidence degradation", async () => {
      const sharedBase = Array.from({ length: 40 }, (_, i) => `instruction single variant candidate word ${i}`).join("\n");
      const queryContent = `# Query Skill\n${sharedBase}\nquery tail\n`;
      const candContent = `# Cand Skill\n${sharedBase}\ncand tail\n`;

      const queryDir = await makeTempSkill({ "SKILL.md": queryContent });
      const querySketch = instructionSketch(normalizeInstructions(queryContent));
      const candSketch = instructionSketch(normalizeInstructions(candContent));
      const candInstrHex = instrHex(candContent);
      const candVarId = variantIdFromInstructionsSha256(candInstrHex);
      const queryAnchors = querySketch.slice(0, 8);

      const anchorShards: Record<string, AnchorShard> = {};
      for (const anchor of candSketch.slice(0, 8)) {
        if (queryAnchors.includes(anchor)) {
          const pfx = anchorShardPrefix(anchor);
          anchorShards[pfx] = { [anchor]: [candVarId] };
        }
      }

      const indexDir = await makeIndex({
        anchorShards,
        sketchShards: {
          [variantSketchRoute(candVarId).key]: {
            [candVarId]: {
              instructionsSha256: candInstrHex,
              sketch: candSketch,
            },
          },
        },
        enrichmentShards: {
          [variantEnrichmentRoute(candInstrHex).key]: {
            [candInstrHex]: {
              rawVariantCount: 1,
              copyCount: 1,
              examples: [{ repoFullName: "solo/skill", path: "SKILL.md", stars: 5 }],
            },
          },
        },
        instructionHistoryShards: {
          [instructionHistoryRoute(candInstrHex).key]: {
            [candInstrHex]: {
              totalLocationCount: 1,
              historyFetchedLocationCount: 1,
              usableLocationCount: 1,
              chronologyAnomalyCount: 0,
              conflictingLocationCount: 0,
              coverage: "complete",
              earliestObserved: {
                repoFullName: "solo/skill",
                path: "SKILL.md",
                firstCommitAt: "2026-01-01T00:00:00.000000Z",
                lastCommitAt: null,
              },
              latestObserved: {
                repoFullName: "solo/skill",
                path: "SKILL.md",
                firstCommitAt: "2026-01-01T00:00:00.000000Z",
                lastCommitAt: null,
              },
            },
          },
        },
      });

      const report = await traceSkill(queryDir, indexDir, TOOL_VERSION);
      expect(report.match.type).toBe("variant_candidates");
      if (report.match.type !== "variant_candidates") return;

      expect(report.match.candidates).toHaveLength(1);
      expect(report.match.temporalEvidence).toEqual({
        status: "not_available",
        semantics: "dataset_observation_order_only",
        basis: "earliest_observed_first_commit_at",
        reason: "fewer_than_two_candidates",
        candidateCount: 1,
        totalPairCount: 0,
        comparablePairCount: 0,
        nonComparablePairCount: 0,
        relations: [],
      });
      expect(report.match.evidenceGraph.edgeCount).toBe(1);
      expect(report.match.evidenceGraph.similarityEdgeCount).toBe(1);
      expect(report.match.evidenceGraph.temporalObservationEdgeCount).toBe(0);
      expect(report.evidenceSummary.facts.some((f) => f.code === "temporal_comparability" && f.text.includes("fewer than two final candidates"))).toBe(true);
    });
  });

  describe("Match Type 4: none", () => {
    it("produces deterministic report when no index matches exist", async () => {
      const skillContent = "# Unmatched Skill\nCompletely unique and unindexed content xyz123.\n";
      const skillDir = await makeTempSkill({ "SKILL.md": skillContent });
      const indexDir = await makeIndex();

      const report = await traceSkill(skillDir, indexDir, TOOL_VERSION);

      expect(report.schemaVersion).toBe("0.5");
      expect(report.origin).toEqual({ status: "not_inferred" });
      expect(report.query.gitBlobSha1).toMatch(/^sha1:[0-9a-f]{40}$/);
      expect(report.query.instructionsSha256).toMatch(/^sha256:[0-9a-f]{64}$/);

      expect(report.match).toEqual({
        type: "none",
        copyCount: 0,
        occurrences: [],
      });

      expect(report.match).not.toHaveProperty("temporalEvidence");
      expect(report.match).not.toHaveProperty("evidenceGraph");
      expect(report.match).not.toHaveProperty("history");

      expect(report.evidenceSummary).toEqual({
        semantics: "derived_from_trace_evidence_only",
        headline: "No match met the current index and retrieval criteria.",
        facts: [
          {
            code: "match",
            text: "No exact, same-instructions, or approximate variant match met the current index and retrieval criteria.",
          },
        ],
        limitations: [
          {
            code: "no_match_not_global_absence",
            text: "A none result does not prove that no related Skill exists outside the current index or retrieval criteria.",
          },
        ],
      });
    });
  });
});
