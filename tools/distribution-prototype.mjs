#!/usr/bin/env node
/**
 * Synthetic-only, offline-by-default distribution-contract prototype.
 * Source-only tooling: no change to the published CLI.
 * NOT a signature, rights clearance, or production HTTP client.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rm, link } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'skilllineage-synthetic-distribution-v1';
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const HEX_SHA = /^[a-f0-9]{64}$/;
const ROUTE = /^(?:manifest\.json|(?:exact|instructions|variants\/anchors)\/[a-f0-9]{2}\.json\.gz|variants\/(?:sketches|enrichment)\/[a-f0-9]{2}\/[a-f0-9]{2}\.json\.gz|history\/(?:exact|instructions)\/[a-f0-9]{2}\/[a-f0-9]{2}\.json\.gz)$/;
const PIN = /^synthetic-v[0-9]+$/;
function reject(message) { throw new Error(message); }
export function validRoute(value) { return typeof value === 'string' && ROUTE.test(value); }
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(manifest) { return JSON.stringify(manifest, null, 2) + '\n'; }
function isWithin(root, p) {
  const relative = path.relative(root, p);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function pieces(route) { return route.split('/'); }
async function fileDigest(filename) {
  let size = 0;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length;
    if (size > MAX_FILE_BYTES) reject('File exceeds maximum allowed bytes: ' + filename);
    hash.update(chunk);
  }
  return { sizeBytes: size, sha256: hash.digest('hex') };
}
async function scanFiles(root) {
  const found = [];
  async function walk(directory, prefix) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const rel = prefix ? prefix + '/' + item.name : item.name;
      const full = path.join(directory, item.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) reject('Symlinks forbidden in distribution sources: ' + rel);
      if (info.isDirectory()) await walk(full, rel);
      else if (info.isFile()) {
        if (!validRoute(rel)) reject('Invalid shard route: ' + rel);
        found.push(rel);
      } else reject('Non-regular index entry: ' + rel);
      if (found.length > MAX_ENTRIES) reject('Too many index files');
    }
  }
  await walk(root, '');
  return found.sort();
}
export async function prepareDistribution(indexDir, destination) {
  const root = path.resolve(indexDir), dest = path.resolve(destination);
  const st = await lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink()) reject('Index must be a regular directory');
  if (isWithin(root, dest)) reject('Manifest must be outside source index');
  const source = JSON.parse((await readFile(path.join(root, 'manifest.json'))).toString('utf8'));
  if (source.schemaVersion !== '0.5' || source.kind !== 'skilllineage-exact-index' ||
      source.source?.name !== 'SkillLineage synthetic onboarding fixture' ||
      source.source?.snapshot !== 'synthetic-v1') reject('Prototype accepts only the known synthetic fixture source declaration');
  const routes = await scanFiles(root);
  if (!routes.includes('manifest.json')) reject('Missing index manifest');
  const records = [];
  for (const route of routes) records.push({ path: route, ...await fileDigest(path.join(root, ...pieces(route))) });
  const distribution = {
    format: FORMAT, indexSchemaVersion: '0.5', snapshotId: 'synthetic-v1',
    syntheticOnly: true, fileCount: records.length, files: records
  };
  const output = canonical(distribution);
  const handle = await open(dest, 'wx', 0o600);
  try { await handle.writeFile(output); } finally { await handle.close(); }
  return { path: dest, sha256: sha256(Buffer.from(output)), fileCount: records.length };
}
function validateManifest(raw) {
  const d = JSON.parse(raw);
  if (d?.format !== FORMAT || d?.indexSchemaVersion !== '0.5' ||
      d?.syntheticOnly !== true || !PIN.test(d.snapshotId ?? '') ||
      !Number.isSafeInteger(d.fileCount) || d.fileCount < 1 ||
      d.fileCount > MAX_ENTRIES || !Array.isArray(d.files) || d.files.length !== d.fileCount) {
    reject('Unrecognized distribution manifest contract');
  }
  let last = '';
  for (const x of d.files) {
    if (!validRoute(x?.path) || x.path <= last ||
        !Number.isSafeInteger(x.sizeBytes) || x.sizeBytes < 0 || x.sizeBytes > MAX_FILE_BYTES ||
        typeof x.sha256 !== 'string' || !HEX_SHA.test(x.sha256)) reject('Invalid, unsorted or duplicate manifest entry');
    last = x.path;
  }
  if (!d.files.some(x => x.path === 'manifest.json')) reject('Missing index manifest entry');
  return d;
}
export async function readPinnedManifest(filename, digestPin) {
  if (typeof digestPin !== 'string' || !HEX_SHA.test(digestPin)) reject('A trusted SHA-256 digest pin is mandatory');
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) reject('Manifest must be a bounded regular file');
  const bytes = await readFile(filename);
  if (sha256(bytes) !== digestPin) reject('Distribution manifest SHA-256 pin mismatch');
  return validateManifest(bytes.toString('utf8'));
}
function assertLocalOrigin(raw) {
  let url;
  try { url = new URL(raw); } catch { reject('Invalid local HTTP URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    reject('Only explicit loopback HTTP origin root is supported (no remote host, URL paths, or credentials)');
  }
  return url;
}
async function ensureCacheDirectory(root, snapshot, route) {
  let dir = root;
  for (const component of [snapshot, ...pieces(route).slice(0, -1)]) {
    dir = path.join(dir, component);
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (err) { if (err?.code !== 'EEXIST') throw err; }
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) reject('Unsafe cache directory: ' + dir);
  }
  return dir;
}
async function cacheRootGuard(root) {
  const abs = path.resolve(root);
  const st = await lstat(abs);
  if (!st.isDirectory() || st.isSymbolicLink()) reject('Cache root must be an existing real directory');
  return abs;
}
async function readCached(file, entry) {
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.isSymbolicLink()) reject('Unsafe cache entry');
    const got = await fileDigest(file);
    if (got.sizeBytes !== entry.sizeBytes || got.sha256 !== entry.sha256) reject('Corrupted cache entry (fail closed)');
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}
async function boundedResponse(response, entry) {
  if (response.status !== 200) reject('HTTP request rejected with status ' + response.status);
  const length = response.headers.get('content-length');
  if (length && Number(length) > entry.sizeBytes) reject('HTTP content-length exceeds pinned expected size');
  if (!response.body) reject('Missing response body');
  const reader = response.body.getReader();
  const chunks = [];
  const hash = createHash('sha256');
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > entry.sizeBytes || size > MAX_FILE_BYTES) reject('Response exceeds pinned expected size');
      hash.update(value);
      chunks.push(Buffer.from(value));
    }
  } catch (err) { await reader.cancel().catch(() => {}); throw err; }
  if (size !== entry.sizeBytes || hash.digest('hex') !== entry.sha256) reject('Downloaded shard fails SHA-256 or byte-count validation');
  return Buffer.concat(chunks, size);
}
export async function hydrateSyntheticShard({ manifestFile, pinnedSha256, baseUrl, shardPath, cacheDir, allowLoopbackNetwork = false }) {
  if (!allowLoopbackNetwork) reject('Explicit --allow-loopback-network consent is required');
  const manifest = await readPinnedManifest(manifestFile, pinnedSha256);
  if (!validRoute(shardPath)) reject('Invalid shard route');
  const entry = manifest.files.find(x => x.path === shardPath);
  if (!entry) reject('Shard absent from pinned manifest');
  const origin = assertLocalOrigin(baseUrl);
  const root = await cacheRootGuard(cacheDir);
  const directory = await ensureCacheDirectory(root, manifest.snapshotId, shardPath);
  const finalPath = path.join(directory, path.basename(shardPath));
  if (await readCached(finalPath, entry)) return { status: 'cache_hit', path: finalPath, sha256: entry.sha256 };
  const requestUrl = new URL(pieces(shardPath).map(encodeURIComponent).join('/'), origin);
  const response = await fetch(requestUrl, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  const bytes = await boundedResponse(response, entry);
  const temp = path.join(directory, '.' + path.basename(shardPath) + '.' + randomUUID() + '.tmp');
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  try {
    // Hard-link into place without overwriting an existing cache entry (also works with concurrent consumers).
    try { await link(temp, finalPath); }
    catch(err) {
      if (err?.code !== 'EEXIST') throw err;
      if (!await readCached(finalPath, entry)) reject('Cache raced with a nonmatching entry');
    }
  } finally { await rm(temp, { force: true }); }
  return { status: 'downloaded_verified', path: finalPath, sha256: entry.sha256 };
}
async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'prepare' && args.length === 2) {
    const result = await prepareDistribution(args[0], args[1]);
    console.log(JSON.stringify({ ...result, warning: 'Synthetic-only; not publisher-signed or public redistribution clearance' }, null, 2));
  } else if (action === 'fetch' && args.length === 6 && args[5] === '--allow-loopback-network') {
    console.log(JSON.stringify(await hydrateSyntheticShard({
      manifestFile: args[0], pinnedSha256: args[1], baseUrl: args[2],
      shardPath: args[3], cacheDir: args[4], allowLoopbackNetwork: true
    }), null, 2));
  } else {
    console.error('Usage:\n  node tools/distribution-prototype.mjs prepare <synthetic-index> <new-distribution-manifest.json>\n  node tools/distribution-prototype.mjs fetch <manifest.json> <trusted-manifest-sha256> <http://127.0.0.1:PORT/> <shard-path> <existing-cache-dir> --allow-loopback-network');
    process.exitCode = 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error('ERROR: ' + err.message); process.exitCode = 1; });
}
