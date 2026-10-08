#!/usr/bin/env node
// PR #20: local-only synthetic gzip sidecar and snapshot session invariants.
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
  prepareDistribution, compactSyntheticManifest, readPinnedCompressedManifest,
  createPinnedSyntheticSession, sha256, validRoute
} from './distribution-prototype.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await mkdtemp(path.join(tmpdir(), 'skilllineage-session-'));
const demo = path.join(tmp, 'demo');
const index = path.join(demo, 'index');
const cacheDir = path.join(tmp, 'cache');
const rawFile = path.join(tmp, 'distribution.json');
const gzFile = path.join(tmp, 'distribution.json.gz');
const requests = [];
let server;
try {
  await run(process.execPath, [path.join(root, 'tools', 'create-demo-fixture.mjs'), demo]);
  await mkdir(cacheDir);
  const raw = await prepareDistribution(index, rawFile);
  const compact = await compactSyntheticManifest(rawFile, raw.sha256, gzFile);
  assert.equal(compact.originalBytes, (await readFile(rawFile)).length);
  assert.equal(compact.compressedBytes, (await readFile(gzFile)).length);
  assert(compact.compressedBytes < 0.7 * compact.originalBytes, 'Gzip should save meaningful bytes');
  const second = await compactSyntheticManifest(rawFile, raw.sha256, path.join(tmp, 'repeat.gz'));
  assert.equal(second.sha256, compact.sha256, 'Gzip sidecar is deterministic');
  assert.equal(second.compressedBytes, compact.compressedBytes);
  await assert.rejects(compactSyntheticManifest(rawFile, raw.sha256, gzFile), /EEXIST/);
  await assert.rejects(compactSyntheticManifest(rawFile, '0'.repeat(64), path.join(tmp, 'bad.gz')), /pin mismatch/);
  await assert.rejects(readPinnedCompressedManifest(gzFile, '0'.repeat(64)), /pin mismatch/);
  const gzipManifest = await readPinnedCompressedManifest(gzFile, compact.sha256);
  assert.equal(gzipManifest.fileCount, 769);
  assert.equal(gzipManifest.snapshotId, 'synthetic-v1');
  const bomb = gzipSync(Buffer.alloc(6 * 1024 * 1024, 0x78));
  const bombFile = path.join(tmp, 'bomb.gz');
  await writeFile(bombFile, bomb);
  await assert.rejects(readPinnedCompressedManifest(bombFile, sha256(bomb)), /overlong|too large|limit|Invalid/);

  server = createServer(async (req, res) => {
    const route = (req.url ?? '').slice(1);
    if (req.method !== 'GET' || !validRoute(route)) { res.writeHead(404); res.end(); return; }
    requests.push(route);
    try {
      const bytes = await readFile(path.join(index, ...route.split('/')));
      res.writeHead(200, { 'Content-Length': bytes.length });
      res.end(bytes);
    } catch {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/';
  const config = {
    manifestFile: gzFile, pinnedSha256: compact.sha256, compression: 'gzip',
    baseUrl, cacheDir, allowLoopbackNetwork: true
  };
  await assert.rejects(createPinnedSyntheticSession({ ...config, allowLoopbackNetwork: false }), /Explicit/);
  await assert.rejects(createPinnedSyntheticSession({ ...config, baseUrl: 'https://example.com/' }), /loopback/);
  const session = await createPinnedSyntheticSession(config);
  assert(Object.isFrozen(session));
  assert.equal(session.manifestValidations, 1);
  assert.equal(session.fileCount, 769);
  const missing = await session.resolve(['history/exact/00/00.json.gz']);
  assert.deepEqual(missing, {
    status: 'indeterminate', snapshotId: 'synthetic-v1',
    reason: 'missing_in_manifest', missingRoutes: ['history/exact/00/00.json.gz']
  });
  assert.equal(requests.length, 0, 'Missing route must not trigger HTTP');
  const invalid = await session.resolve(['../../secret']);
  assert.equal(invalid.status, 'indeterminate');
  assert.equal(invalid.reason, 'policy');
  assert.equal(requests.length, 0);

  const cold = await session.resolve(['exact/00.json.gz', 'instructions/ff.json.gz']);
  assert.equal(cold.status, 'complete');
  assert.equal(cold.verified.length, 2);
  assert.deepEqual(requests, ['exact/00.json.gz', 'instructions/ff.json.gz']);

  // Once a manifest is verified, the snapshot session retains only its
  // authenticated in-memory records; it does not trust later disk mutations.
  const originalGzip = await readFile(gzFile);
  await writeFile(gzFile, Buffer.from('manifest changed after session construction'));
  await assert.rejects(createPinnedSyntheticSession(config), /pin mismatch/);
  const warm = await session.resolve(['exact/00.json.gz', 'instructions/ff.json.gz']);
  assert.equal(warm.status, 'complete');
  assert(warm.verified.every(x => x.status === 'cache_hit'));
  assert.equal(requests.length, 2, 'Warm session must not contact HTTP again');
  await writeFile(gzFile, originalGzip);

  const poisoned = cold.verified[0].path;
  await writeFile(poisoned, Buffer.from('tampered cached contents'));
  const poisonedResult = await session.resolve(['exact/00.json.gz', 'instructions/ff.json.gz']);
  assert.equal(poisonedResult.status, 'indeterminate');
  assert.equal(poisonedResult.reason, 'integrity');
  assert(poisonedResult.missingRoutes.includes('exact/00.json.gz'));
  assert.equal(requests.length, 2, 'Corrupt cache must fail closed without HTTP reload');

  // Rehydration is a separate explicit step; it cannot assert a no-match.
  const fresh = await createPinnedSyntheticSession({
    ...config, cacheDir: path.join(tmp, 'missing-cache')
  }).then(() => false, err => /Cache root/.test(err.message));
  assert.equal(fresh, true, 'A missing cache root must be rejected');

  const plainSession = await createPinnedSyntheticSession({
    manifestFile: rawFile, pinnedSha256: raw.sha256, compression: 'none',
    baseUrl, cacheDir, allowLoopbackNetwork: true
  });
  const absent = await plainSession.resolve(['history/instructions/ff/ff.json.gz']);
  assert.equal(absent.status, 'indeterminate');
  assert.equal(absent.reason, 'missing_in_manifest');
  console.log(JSON.stringify({
    test: 'synthetic gzip manifest / immutable pinned session / fail-closed adapter',
    distributionFiles: gzipManifest.fileCount,
    originalManifestBytes: compact.originalBytes,
    gzipManifestBytes: compact.compressedBytes,
    compressionRatio: +(compact.compressedBytes / compact.originalBytes).toFixed(4),
    coldHTTPRequests: 2,
    warmHTTPRequests: 0,
    sessionManifestValidations: session.manifestValidations,
    completeness: 'NO_MATCH_NEVER_INFERRED_FROM_MISSING_ROUTES',
    result: 'PASS'
  }));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(tmp, { recursive: true, force: true });
}
