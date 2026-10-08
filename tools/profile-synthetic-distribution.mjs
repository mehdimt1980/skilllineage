#!/usr/bin/env node
/**
 * PR #19: isolated, synthetic-only loopback/cache profiling.
 * Measures application-body bytes, not wire framing/TLS or CDN charges.
 * No real GitSkills data, external network access or production index reader.
 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { hydrateSyntheticShard, prepareDistribution, readPinnedManifest, validRoute } from './distribution-prototype.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORMAT = 'skilllineage-synthetic-profile-v1';
function invalid(message) { throw new Error(message); }
function options(argv) {
  const values = { samples: 32, extraShards: 256 };
  const mapping = { '--samples': 'samples', '--extra-shards': 'extraShards' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], prop = mapping[key];
    if (!prop || seen.has(key) || i + 1 >= argv.length || !/^[0-9]+$/.test(argv[i + 1] ?? ''))
      invalid('Use --samples <1..128> --extra-shards <0..256> (each once)');
    seen.add(key);
    values[prop] = Number(argv[i + 1]);
  }
  if (!Number.isSafeInteger(values.samples) || values.samples < 1 || values.samples > 128 ||
      !Number.isSafeInteger(values.extraShards) || values.extraShards < 0 || values.extraShards > 256)
    invalid('Bounded sample/extra-shard configuration required');
  return values;
}
function percentile(arr, fraction) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function rounded(n) { return Math.round(n * 1000) / 1000; }
async function addSyntheticSparse(index, count) {
  for (let i = 0; i < count; i++) {
    const hi = Math.floor(i / 16).toString(16).padStart(2, '0');
    const lo = (i % 16).toString(16).padStart(2, '0');
    const parent = path.join(index, 'variants', 'sketches', hi);
    await mkdir(parent, { recursive: true });
    // No source skills and no invented human/repo metadata; valid gzip JSON shard.
    await writeFile(path.join(parent, lo + '.json.gz'), gzipSync(Buffer.from('{}')));
  }
}
async function runProfile(opts) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'skilllineage-profile-'));
  const demo = path.join(tmp, 'demo'), index = path.join(demo, 'index');
  const manifestFile = path.join(tmp, 'dist-manifest.json');
  const cacheDir = path.join(tmp, 'cache');
  let server;
  try {
    await run(process.execPath, [path.join(root, 'tools/create-demo-fixture.mjs'), demo], { timeout: 120_000 });
    await addSyntheticSparse(index, opts.extraShards);
    await mkdir(cacheDir);
    const generated = await prepareDistribution(index, manifestFile);
    const manifest = await readPinnedManifest(manifestFile, generated.sha256);
    const all = manifest.files.filter(f => f.path !== 'manifest.json');
    if (opts.samples > all.length) invalid('Not enough distinct shards to sample');
    const selected = [];
    for (let i = 0; i < opts.samples; i++) {
      const pos = Math.floor((i + 0.5) * all.length / opts.samples);
      selected.push(all[pos]);
    }
    assert.equal(new Set(selected.map(x => x.path)).size, selected.length);
    const selectedBytes = selected.reduce((n, x) => n + x.sizeBytes, 0);
    const totalIndexedBytes = manifest.files.reduce((n, x) => n + x.sizeBytes, 0);
    const requests = [];
    let servedBytes = 0;
    server = createServer(async (req, res) => {
      // Literal path routing only; deliberately no remote proxying or guessable wildcard.
      const route = req.url?.slice(1);
      if (req.method !== 'GET' || !validRoute(route) || !manifest.files.some(x => x.path === route)) {
        res.writeHead(404); res.end(); return;
      }
      const body = await readFile(path.join(index, ...route.split('/')));
      requests.push(route);
      servedBytes += body.length;
      res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
      res.end(body);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const args = {
      manifestFile, pinnedSha256: generated.sha256,
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/',
      cacheDir, allowLoopbackNetwork: true
    };
    const coldMs = [], warmMs = [];
    const coldStarted = performance.now();
    for (const entry of selected) {
      const started = performance.now();
      const result = await hydrateSyntheticShard({ ...args, shardPath: entry.path });
      coldMs.push(performance.now() - started);
      assert.equal(result.status, 'downloaded_verified');
    }
    const coldElapsed = performance.now() - coldStarted;
    const coldRequests = requests.length, coldBodyBytes = servedBytes;
    assert.equal(coldRequests, selected.length, 'Cold fetch must contact HTTP server exactly once per selected shard');
    assert.equal(coldBodyBytes, selectedBytes, 'Counted HTTP body bytes must match pinned manifest');
    const warmStarted = performance.now();
    for (const entry of selected) {
      const started = performance.now();
      const result = await hydrateSyntheticShard({ ...args, shardPath: entry.path });
      warmMs.push(performance.now() - started);
      assert.equal(result.status, 'cache_hit');
    }
    const warmElapsed = performance.now() - warmStarted;
    assert.equal(requests.length, coldRequests, 'Warm cache must perform zero HTTP GET requests');
    assert.equal(servedBytes, coldBodyBytes, 'Warm cache must transfer zero extra HTTP body bytes');

    const totalManifestBytes = (await stat(manifestFile)).size;
    const stats = {
      format: FORMAT,
      syntheticOnly: true, networkScope: 'loopback-only',
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      fixture: {
        originalShardFileCount: 769,
        addedSparseShardCount: opts.extraShards,
        distributionFileCount: manifest.fileCount,
        selectedDistinctShards: selected.length,
        totalIndexedBytes,
        selectedShardBytes: selectedBytes,
        distributionManifestBytes: totalManifestBytes,
        // Document all fixed client-side work; manifest is read and re-hashed for each request.
        manifestVerification: 'performed-per-shard'
      },
      cold: {
        cacheMisses: selected.length, httpRequests: coldRequests,
        httpResponseBodyBytes: coldBodyBytes,
        elapsedMs: rounded(coldElapsed),
        p50Ms: rounded(percentile(coldMs, 0.5)),
        p95Ms: rounded(percentile(coldMs, 0.95))
      },
      warm: {
        cacheHits: selected.length,
        httpRequests: requests.length - coldRequests,
        httpResponseBodyBytes: servedBytes - coldBodyBytes,
        elapsedMs: rounded(warmElapsed),
        p50Ms: rounded(percentile(warmMs, 0.5)),
        p95Ms: rounded(percentile(warmMs, 0.95))
      },
      completeness: 'SELECTED_SHARDS_ONLY_NOT_A_COMPLETE_INDEX',
      queryPrivacy: 'Shard request paths visible to loopback server',
      limitations: [
        'Synthetic empty gzip shards: not a real GitSkills size, retrieval-quality, CPU or privacy benchmark.',
        'Local loopback timings include Node.js manifest re-hashing, filesystem and scheduling; not internet/CDN latency.',
        'HTTP response-body bytes exclude headers, TCP/IP, TLS framing, retransmissions, and manifest distribution.',
        'Partial caches cannot be passed to trace as complete indexes; absence must never imply global no-match.',
        'No right to redistribute any GitSkills-derived index has been established.'
      ]
    };
    assert.equal(stats.fixture.distributionFileCount, 769 + opts.extraShards);
    return stats;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
}
try {
  const result = await runProfile(options(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error('ERROR: ' + err.message);
  process.exitCode = 1;
}
