#!/usr/bin/env node
// End-to-end local loopback HTTP tests; NO external server or third-party index.
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { hydrateSyntheticShard, prepareDistribution, readPinnedManifest, sha256, validRoute } from './distribution-prototype.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(tmpdir(), 'skilllineage-synthetic-dist-'));
const demo = path.join(temp, 'demo');
const index = path.join(demo, 'index');
const cache = path.join(temp, 'cache');
const manifestFile = path.join(temp, 'distribution-manifest.json');
const requests = [];
let corruptRoute = null;
let redirectRoute = null;
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const route = pathname.slice(1);
  requests.push(route);
  if (!validRoute(route)) { res.writeHead(404); res.end(); return; }
  if (route === redirectRoute) {
    res.writeHead(302, { location: 'https://example.com/never-follow' }); res.end(); return;
  }
  let bytes;
  try { bytes = await readFile(path.join(index, ...route.split('/'))); }
  catch { res.writeHead(404); res.end(); return; }
  if (route === corruptRoute) {
    bytes = Buffer.from(bytes);
    bytes[0] ^= 0x1; // same length, invalid SHA-256
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
  res.end(bytes);
});
async function rejectAsync(fn, pattern) { await assert.rejects(fn, pattern); }
try {
  await exec(process.execPath, [path.join(root, 'tools/create-demo-fixture.mjs'), demo]);
  await mkdir(cache);
  const created = await prepareDistribution(index, manifestFile);
  assert.equal(created.fileCount, 769);
  assert.match(created.sha256, /^[0-9a-f]{64}$/);
  const repeat = path.join(temp, 'repeat.json');
  const other = await prepareDistribution(index, repeat);
  assert.equal(created.sha256, other.sha256, 'Manifest must be deterministic');
  assert.deepEqual(await readFile(manifestFile), await readFile(repeat));
  const contents = await readPinnedManifest(manifestFile, created.sha256);
  assert.equal(contents.fileCount, 769);
  assert.equal(contents.snapshotId, 'synthetic-v1');
  await rejectAsync(() => prepareDistribution(index, manifestFile), /EEXIST/);
  await rejectAsync(() => prepareDistribution(index, path.join(index, 'distribution.json')), /outside source index/);
  await rejectAsync(() => readPinnedManifest(manifestFile, '0'.repeat(64)), /pin mismatch/);
  await rejectAsync(() => readPinnedManifest(manifestFile, 'not-a-digest'), /trusted SHA/);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/';
  const params = { manifestFile, pinnedSha256: created.sha256, baseUrl, cacheDir: cache, allowLoopbackNetwork: true };
  const r1 = await hydrateSyntheticShard({ ...params, shardPath: 'exact/00.json.gz' });
  assert.equal(r1.status, 'downloaded_verified');
  assert.equal(sha256(await readFile(r1.path)), contents.files.find(x => x.path === 'exact/00.json.gz').sha256);
  assert.equal(requests.length, 1);
  const r2 = await hydrateSyntheticShard({ ...params, shardPath: 'exact/00.json.gz' });
  assert.equal(r2.status, 'cache_hit');
  assert.equal(requests.length, 1, 'Cache hit must not contact network');
  const r3 = await hydrateSyntheticShard({ ...params, shardPath: 'instructions/ff.json.gz' });
  assert.equal(r3.status, 'downloaded_verified');
  assert.deepEqual(requests, ['exact/00.json.gz', 'instructions/ff.json.gz']);

  for (const unsafe of ['../sensitive', '/etc/passwd', 'variants/anchors/../../secret', 'https://evil.example/a']) {
    await rejectAsync(() => hydrateSyntheticShard({ ...params, shardPath: unsafe }), /Invalid shard route/);
  }
  for (const remote of ['https://example.com/', 'http://example.com/', 'http://localhost:8000/', 'http://127.0.0.1:80/a/', 'http://user:pass@127.0.0.1/']) {
    await rejectAsync(() => hydrateSyntheticShard({ ...params, baseUrl: remote, shardPath: 'manifest.json' }), /loopback/);
  }
  await rejectAsync(() => hydrateSyntheticShard({ ...params, allowLoopbackNetwork: false, shardPath: 'manifest.json' }), /Explicit/);
  await rejectAsync(() => hydrateSyntheticShard({ ...params, pinnedSha256: '1'.repeat(64), shardPath: 'manifest.json' }), /pin mismatch/);
  await rejectAsync(() => hydrateSyntheticShard({ ...params, shardPath: 'history/exact/00/00.json.gz' }), /absent/);
  assert.equal(requests.length, 2, 'Rejected requests must not contact network');

  await writeFile(r1.path, Buffer.from('poisoned cache'));
  await rejectAsync(() => hydrateSyntheticShard({ ...params, shardPath: 'exact/00.json.gz' }), /Corrupted cache/);
  assert.equal(requests.length, 2, 'Corrupt cache must not trigger network replacement');

  corruptRoute = 'manifest.json';
  await rejectAsync(() => hydrateSyntheticShard({ ...params, shardPath: 'manifest.json' }), /exceeds pinned expected size|fails SHA/);
  corruptRoute = null;
  assert.equal((await readdir(path.join(cache, 'synthetic-v1'))).includes('manifest.json'), false);
  redirectRoute = 'manifest.json';
  await rejectAsync(() => hydrateSyntheticShard({ ...params, shardPath: 'manifest.json' }), /fetch failed|redirect/i);
  redirectRoute = null;
  const m = await hydrateSyntheticShard({ ...params, shardPath: 'manifest.json' });
  assert.equal(m.status, 'downloaded_verified');
  assert.equal(sha256(await readFile(m.path)), contents.files.find(x=>x.path==='manifest.json').sha256);

  const hacked = JSON.parse(await readFile(manifestFile, 'utf8'));
  hacked.files[0].path = '../bad';
  const hackedFile = path.join(temp, 'hacked.json');
  const hackedBytes = Buffer.from(JSON.stringify(hacked));
  await writeFile(hackedFile, hackedBytes);
  await rejectAsync(() => readPinnedManifest(hackedFile, sha256(hackedBytes)), /Invalid.*entry/);

  const alternate = path.join(temp, 'alt-cache');
  await mkdir(alternate);
  let symlinkCreated = false;
  try { await symlink(demo, path.join(alternate, 'synthetic-v1'), 'dir'); symlinkCreated = true; }
  catch(err) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) throw err; }
  if (symlinkCreated) {
    await rejectAsync(() => hydrateSyntheticShard({ ...params, cacheDir: alternate, shardPath: 'exact/00.json.gz' }), /Unsafe cache directory/);
  }
  let badCLI;
  try { await exec(process.execPath,[path.join(root,'tools/distribution-prototype.mjs'),'fetch']); } catch(e) { badCLI = e; }
  assert(badCLI && badCLI.code === 2);
  console.log('PASS: synthetic manifest, trusted digest pin, selective loopback GET, offline cache hit, corruption, path, redirect, overwrite and symlink guards');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
