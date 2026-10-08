#!/usr/bin/env node
// Synthetic-only invariants. No network calls beyond profiler's temporary loopback server.
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const filename = path.join(path.dirname(fileURLToPath(import.meta.url)), 'profile-synthetic-distribution.mjs');
async function profile(...args) {
  const { stdout } = await exec(process.execPath, [filename, ...args], {
    timeout: 120_000, maxBuffer: 2_000_000
  });
  return JSON.parse(stdout);
}
for (const [extraShards, samples] of [[0, 6], [64, 12]]) {
  const report = await profile('--samples', String(samples), '--extra-shards', String(extraShards));
  assert.equal(report.format, 'skilllineage-synthetic-profile-v1');
  assert.equal(report.syntheticOnly, true);
  assert.equal(report.networkScope, 'loopback-only');
  assert.equal(report.fixture.distributionFileCount, 769 + extraShards);
  assert.equal(report.fixture.addedSparseShardCount, extraShards);
  assert.equal(report.fixture.selectedDistinctShards, samples);
  assert.equal(report.cold.httpRequests, samples);
  assert.equal(report.cold.cacheMisses, samples);
  assert.equal(report.cold.httpResponseBodyBytes, report.fixture.selectedShardBytes);
  assert.equal(report.warm.httpRequests, 0);
  assert.equal(report.warm.httpResponseBodyBytes, 0);
  assert.equal(report.warm.cacheHits, samples);
  assert.equal(report.completeness, 'SELECTED_SHARDS_ONLY_NOT_A_COMPLETE_INDEX');
  assert(report.fixture.totalIndexedBytes > report.fixture.selectedShardBytes);
  for (const stage of ['cold', 'warm']) {
    assert(report[stage].p50Ms >= 0);
    assert(report[stage].p95Ms >= report[stage].p50Ms);
    assert(report[stage].elapsedMs >= 0);
  }
}
for (const args of [
  ['--samples', '0'], ['--samples', '129'], ['--extra-shards', '257'],
  ['--extra-shards', '-1'], ['--samples', 'abc'], ['--samples'],
  ['--unknown', '2'], ['--samples', '4', '--samples', '5']
]) {
  await assert.rejects(profile(...args), e => e.code !== 0);
}
console.log('PASS: 0/64 extra-shard synthetic profile sizes, exact request and response-body accounting, zero-byte warm cache, bounded inputs.');
