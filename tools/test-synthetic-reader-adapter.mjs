#!/usr/bin/env node
// End-to-end synthetic pinned-shard adapter tests. Never contacts public hosts.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createPinnedSyntheticSession, prepareDistribution, sha256, validRoute } from './distribution-prototype.mjs';
import { previewSyntheticEvidence } from './synthetic-reader-adapter.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await mkdtemp(path.join(tmpdir(), 'skilllineage-adapter-'));
const demo = path.join(tmp, 'demo'), index = path.join(demo, 'index'), cache = path.join(tmp, 'cache');
const manifest = path.join(tmp, 'distribution.json');
let server;
const requests = [];
try {
  await run(process.execPath, [path.join(root, 'tools/create-demo-fixture.mjs'), demo]);
  await mkdir(cache);
  const data = await prepareDistribution(index, manifest);
  const indexed = await readFile(path.join(demo, 'skills/indexed/SKILL.md'));
  const blob = createHash('sha1').update(Buffer.from('blob ' + indexed.length + '\0')).update(indexed).digest('hex');
  const normalizedInstructions = indexed.toString('utf8').slice(indexed.toString('utf8').indexOf('# Instructions\n'));
  const instructions = createHash('sha256').update(normalizedInstructions).digest('hex');
  assert.equal(instructions.length, 64);
  const query = { gitBlobSha1: blob, instructionsSha256: instructions };

  server = createServer(async (req, res) => {
    const route = (req.url ?? '').slice(1);
    if (req.method !== 'GET' || !validRoute(route)) { res.writeHead(404); res.end(); return; }
    requests.push(route);
    try {
      const body = await readFile(path.join(index, ...route.split('/')));
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/';
  const config = { manifestFile: manifest, pinnedSha256: data.sha256, baseUrl, cacheDir: cache, allowLoopbackNetwork: true };
  const session = await createPinnedSyntheticSession(config);
  const exact = await previewSyntheticEvidence(session, query);
  assert.equal(exact.status, 'verified_positive');
  assert.equal(exact.tier, 'exact');
  assert.equal(exact.evidence.copyCount, 1);
  assert.deepEqual(exact.origin, { status: 'not_inferred' });
  assert.equal(exact.history, 'not_evaluated');
  assert.equal(exact.variants, 'not_evaluated');
  assert.deepEqual(exact.checkedRoutes, ['exact/' + blob.slice(0, 2) + '.json.gz']);
  assert.equal(requests.length, 1);

  const metadataOnly = await previewSyntheticEvidence(session, {
    gitBlobSha1: '0'.repeat(40), instructionsSha256: instructions
  });
  assert.equal(metadataOnly.status, 'verified_positive');
  assert.equal(metadataOnly.tier, 'same_instructions');
  assert.equal(metadataOnly.evidence.copyCount, 1);
  assert.equal(metadataOnly.evidence.distinctBlobHashCount, 1);
  assert.equal(requests.length, 3); // exact/00, instructions/{prefix}; original exact is cached

  const oldRequests = requests.length;
  const repeat = await previewSyntheticEvidence(session, query);
  assert.equal(repeat.status, 'verified_positive');
  assert.equal(requests.length, oldRequests, 'Repeat evidence must not contact server');

  const absent = await previewSyntheticEvidence(session, {
    gitBlobSha1: '1'.repeat(40), instructionsSha256: 'f'.repeat(64)
  });
  assert.equal(absent.status, 'indeterminate');
  assert.equal(absent.reason, 'variant_index_not_evaluated');
  assert(!('match' in absent) && !('tier' in absent));
  assert.deepEqual(absent.origin, { status: 'not_inferred' });

  const forged = await previewSyntheticEvidence({
    snapshotId: 'synthetic-v1', resolve: async () => ({ status: 'complete', verified: [] })
  }, query);
  assert.equal(forged.status, 'indeterminate');
  assert.equal(forged.reason, 'invalid_input_or_session');
  const invalid = await previewSyntheticEvidence(session, { gitBlobSha1: '../bad', instructionsSha256: instructions });
  assert.equal(invalid.status, 'indeterminate');
  assert.equal(invalid.reason, 'invalid_input_or_session');

  const exactCache = path.join(cache, 'synthetic-v1', 'exact', blob.slice(0, 2) + '.json.gz');
  await writeFile(exactCache, Buffer.from('tampered'));
  const poison = await previewSyntheticEvidence(session, query);
  assert.equal(poison.status, 'indeterminate');
  assert.equal(poison.reason, 'integrity');
  assert.equal(requests.length, oldRequests + 2, 'Corrupt cache must not cause a refetch');

  // New valid snapshot sidecar with missing required shard must NEVER yield a false no-match.
  const cut = JSON.parse(await readFile(manifest, 'utf8'));
  cut.files = cut.files.filter(x => x.path !== 'exact/' + blob.slice(0, 2) + '.json.gz');
  cut.fileCount = cut.files.length;
  const cutFile = path.join(tmp, 'cut-manifest.json');
  const cutBytes = Buffer.from(JSON.stringify(cut));
  await writeFile(cutFile, cutBytes);
  const cutCache = path.join(tmp, 'cut-cache');
  await mkdir(cutCache);
  const cutSession = await createPinnedSyntheticSession({
    ...config, cacheDir: cutCache, manifestFile: cutFile, pinnedSha256: sha256(cutBytes)
  });
  const missing = await previewSyntheticEvidence(cutSession, query);
  assert.equal(missing.status, 'indeterminate');
  assert.equal(missing.reason, 'missing_in_manifest');
  assert(missing.missingRoutes.some(x=>x.startsWith('exact/')));

  // Corrupt-but-pinned gzip in a new fixture: SHA verification alone must not
  // be treated as valid schema/evidence.
  await writeFile(path.join(index, 'exact', blob.slice(0, 2) + '.json.gz'), gzipSync(Buffer.from('[]')));
  const corruptSidecar = path.join(tmp, 'corrupt-distribution.json');
  const corrupt = await prepareDistribution(index, corruptSidecar);
  const corruptCache = path.join(tmp, 'corrupt-cache');
  await mkdir(corruptCache);
  const corruptSession = await createPinnedSyntheticSession({
    ...config, cacheDir: corruptCache, manifestFile: corruptSidecar, pinnedSha256: corrupt.sha256
  });
  const malformed = await previewSyntheticEvidence(corruptSession, query);
  assert.equal(malformed.status, 'indeterminate');
  assert.equal(malformed.reason, 'invalid_or_changed_shard');

  console.log(JSON.stringify({
    test: 'PR21 completeness-aware synthetic evidence adapter',
    exact: exact.status, instructions: metadataOnly.status,
    missing: missing.status, variantUnverified: absent.reason,
    cacheCorruption: poison.status, malformedShard: malformed.status,
    origin: 'not_inferred', result: 'PASS'
  }));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(tmp, { recursive: true, force: true });
}
