#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { traceSkill } from "../dist/index.js";

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
    results.push({
      id: query.id,
      category: query.category,
      expectedInstructionsSha256: query.expectedInstructionsSha256,
      durationMs,
      match: report.match,
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
