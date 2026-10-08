#!/usr/bin/env node
// Redact an existing schema-0.2 benchmark to shareable aggregate evidence.
// Never copy sampleIdentifiers, query paths, detailed cases, or latency raw arrays.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CATEGORIES = ["exact", "sameInstructions", "variantLight", "variantMedium", "none"];
function invalid(message) { throw new Error("Invalid benchmark report: " + message); }
function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) invalid(name);
  return value;
}
function nonnegative(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(name);
  return value;
}
function rate(value, name) {
  const n = nonnegative(value, name);
  if (n > 1) invalid(name);
  return n;
}
function normalize(raw) {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== "0.2") invalid("schemaVersion must be 0.2");
  const ds = raw.dataset ?? {};
  const sampleCount = integer(ds.sampleCount, "dataset.sampleCount", 1);
  integer(ds.requestedSampleCount, "dataset.requestedSampleCount", 1);
  if (sampleCount > ds.requestedSampleCount) invalid("sample count exceeds requested");
  const seed = integer(ds.seed, "dataset.seed");
  const sourceDbBytes = integer(ds.sourceDbBytes, "source DB size", 1);
  const indexTotalBytes = integer(raw.index?.totalBytes, "index.totalBytes", 1);
  const exactHitRate = rate(raw.quality?.exactHitRate, "exactHitRate");
  const sameInstructionsHitRate = rate(raw.quality?.sameInstructionsHitRate, "sameInstructionsHitRate");
  const unrelatedNoneRate = rate(raw.quality?.none?.noneRate, "none.noneRate");

  const recalls = {};
  for (const [name, value] of [
    ["light", raw.quality?.variantLight], ["medium", raw.quality?.variantMedium]
  ]) {
    const a = rate(value?.recallAt1, name + " recall@1");
    const b = rate(value?.recallAt3, name + " recall@3");
    const c = rate(value?.recallAt10, name + " recall@10");
    if (a > b || b > c) invalid(name + " recalls are not monotonic");
    const gt = value?.groundTruthAtLeast070;
    const countAtLeast070 = integer(gt?.count, name + " ground truth count");
    if (countAtLeast070 > sampleCount) invalid(name + " high-similarity count");
    recalls[name] = {
      recallAt1: a, recallAt3: b, recallAt10: c,
      groundTruthAtLeast070Count: countAtLeast070,
      groundTruthAtLeast070RecallAt10: rate(gt?.recallAt10, name + " high-similarity recall@10")
    };
  }

  const latency = {};
  for (const category of CATEGORIES) {
    const m = raw.latencyMs?.[category];
    const count = integer(m?.count, category + ".count", 1);
    if (count !== sampleCount) invalid(category + " latency count differs from sampleCount");
    const p50 = nonnegative(m.p50, category + ".p50");
    const p95 = nonnegative(m.p95, category + ".p95");
    const max = nonnegative(m.max, category + ".max");
    if (p50 > p95 || p95 > max) invalid(category + " percentiles not ordered");
    latency[category] = { count, p50Ms: p50, p95Ms: p95, maxMs: max };
  }

  return {
    format: "skilllineage-aggregate-benchmark-v1",
    sourceReportSchema: "0.2",
    provenance: "derived-from-local-benchmark-report; not independently rerun",
    environment: {
      node: typeof raw.environment?.node === "string" ? raw.environment.node : "unknown",
      python: typeof raw.environment?.python === "string" ? raw.environment.python : "unknown",
      nodePlatform: typeof raw.environment?.nodePlatform === "string" ? raw.environment.nodePlatform : "unknown"
    },
    dataset: { sourceDbBytes, sampleCount, seed },
    index: { totalBytes: indexTotalBytes },
    quality: { exactHitRate, sameInstructionsHitRate, unrelatedNoneRate, variantRecall: recalls },
    latency,
    limitations: [
      "Numbers are measurements from the supplied report, not a rerun or universal performance guarantee.",
      "This aggregate summary contains no sampled repository identifiers or individual case data.",
      "Similarity and dataset observations do not prove origin, authorship, plagiarism or copying direction."
    ]
  };
}

const [input, output, ...other] = process.argv.slice(2);
if (!input || !output || other.length) {
  console.error("Usage: node tools/benchmark-summary.mjs <raw-benchmark.json> <new-aggregate-summary.json>");
  process.exitCode = 2;
} else {
  try {
    if (path.resolve(input) === path.resolve(output)) invalid("input/output must differ");
    const raw = JSON.parse(await readFile(input, "utf8"));
    const result = normalize(raw);
    await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    console.log("Wrote aggregate-only benchmark summary to " + path.resolve(output));
    console.log("This does not rerun the benchmark or certify full-dataset results.");
  } catch (error) {
    console.error("ERROR: " + error.message);
    process.exitCode = 1;
  }
}
