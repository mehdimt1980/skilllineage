#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { traceSkill } from "../dist/index.js";
import { normalizeInstructions } from "../dist/fingerprint/index.js";
import { readAnchorShard, readSketchShard } from "../dist/index/index.js";
import {
  DEFAULT_ANCHOR_COUNT,
  MIN_ESTIMATED_SIMILARITY,
  MIN_SHARED_ANCHORS,
  anchorShardPrefix,
  estimateSketchSimilarity,
  generateVariantCandidates,
  instructionSketch,
  variantIdFromInstructionsSha256,
} from "../dist/variant/index.js";

async function variantDiagnostic(query, indexDir, match) {
  const source = await readFile(`${query.skillPath}/SKILL.md`, "utf-8");
  const localSketch = instructionSketch(normalizeInstructions(source));
  const anchors = localSketch.slice(0, DEFAULT_ANCHOR_COUNT);
  const expectedVariantId = variantIdFromInstructionsSha256(query.expectedInstructionsSha256);
  const anchorCache = new Map();
  let expectedSharedAnchorPostings = 0;
  for (const anchor of anchors) {
    const prefix = anchorShardPrefix(anchor);
    if (!anchorCache.has(prefix)) anchorCache.set(prefix, await readAnchorShard(indexDir, prefix));
    if ((anchorCache.get(prefix)[anchor] ?? []).includes(expectedVariantId)) expectedSharedAnchorPostings++;
  }
  const generated = await generateVariantCandidates(localSketch, (prefix) =>
    Promise.resolve(anchorCache.get(prefix) ?? {}));
  const preScoreEligible = generated.candidates.some((candidate) => candidate.variantId === expectedVariantId);
  const sketchShard = await readSketchShard(indexDir, expectedVariantId.slice(0, 2));
  const expectedSketch = sketchShard[expectedVariantId]?.sketch;
  const estimatedSketchSimilarity = expectedSketch
    ? estimateSketchSimilarity(localSketch, expectedSketch) : null;
  const finalRank = match.type === "variant_candidates"
    ? match.candidates.findIndex((candidate) => candidate.instructionsSha256 === query.expectedInstructionsSha256) + 1
    : 0;
  return {
    expectedVariantId,
    localAnchorCount: anchors.length,
    expectedSharedAnchorPostings,
    preScoreEligible,
    candidateGenerationTruncated: generated.truncated,
    estimatedSketchSimilarity,
    passesEstimatedSimilarityThreshold: estimatedSketchSimilarity !== null && estimatedSketchSimilarity >= MIN_ESTIMATED_SIMILARITY,
    finalRank: finalRank || null,
    minimumSharedAnchors: MIN_SHARED_ANCHORS,
  };
}

const payloadPath = process.argv[2];
if (!payloadPath) {
  console.error("Usage: node tools/run-trace-benchmark.mjs <payload.json>");
  process.exitCode = 2;
} else {
  const payload = JSON.parse(await readFile(payloadPath, "utf-8"));
  const results = [];
  for (const query of payload.queries) {
    const started = performance.now();
    const report = await traceSkill(query.skillPath, payload.indexDir, "benchmark");
    const durationMs = performance.now() - started;
    const diagnostic = query.category.startsWith("variant_")
      ? await variantDiagnostic(query, payload.indexDir, report.match) : null;
    results.push({
      id: query.id,
      category: query.category,
      expectedInstructionsSha256: query.expectedInstructionsSha256,
      durationMs,
      match: report.match,
      diagnostic,
    });
  }
  process.stdout.write(JSON.stringify({
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    results,
  }));
}
