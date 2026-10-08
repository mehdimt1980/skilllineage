#!/usr/bin/env node
/**
 * Phase 21: source-only, synthetic-fixture-only evidence adapter.
 * It DOES NOT replace traceSkill(), does NOT implement variants/history,
 * and NEVER emits trace.match.type="none" from incomplete evidence.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { isPinnedSyntheticSession } from './distribution-prototype.mjs';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_COMPRESSED = 1024 * 1024;
const MAX_JSON = 4 * 1024 * 1024;
const SCOPE = 'synthetic_verified_exact_and_instructions_tiers_only';
const ORIGIN = Object.freeze({ status: 'not_inferred' });

function indeterminate(snapshotId, reason, checkedRoutes, missingRoutes = []) {
  return { status: 'indeterminate', scope: SCOPE, snapshotId, reason,
    checkedRoutes: [...checkedRoutes], missingRoutes: [...missingRoutes], origin: ORIGIN };
}
function checkedMatch(snapshotId, tier, checkedRoutes, evidence) {
  return { status: 'verified_positive', scope: SCOPE, snapshotId, tier,
    checkedRoutes: [...checkedRoutes], evidence,
    history: 'not_evaluated', variants: 'not_evaluated', origin: ORIGIN };
}
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validOccurrence(o) {
  return plainObject(o) &&
    typeof o.repoFullName === 'string' && typeof o.path === 'string' &&
    (o.stars === null || (typeof o.stars === 'number' && Number.isFinite(o.stars))) &&
    (o.locationClass === null || typeof o.locationClass === 'string') &&
    (o.firstCommitAt === null || typeof o.firstCommitAt === 'string') &&
    (o.lastCommitAt === null || typeof o.lastCommitAt === 'string') &&
    (o.historyFetched === null || typeof o.historyFetched === 'boolean');
}
function exactEntry(entry) {
  return plainObject(entry) && Number.isSafeInteger(entry.copyCount) &&
    entry.copyCount >= 1 && Array.isArray(entry.occurrences) &&
    entry.occurrences.length >= 1 &&
    entry.copyCount === entry.occurrences.length &&
    entry.occurrences.every(validOccurrence);
}
async function resolveVerifiedJson(session, route) {
  const result = await session.resolve([route]);
  if (result.status !== 'complete') {
    return { ok: false, reason: result.reason ?? 'unavailable', missing: result.missingRoutes ?? [route] };
  }
  if (!Array.isArray(result.verified) || result.verified.length !== 1 ||
      result.verified[0].route !== route || typeof result.verified[0].sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.verified[0].sha256)) {
    return { ok: false, reason: 'inconsistent_resolution', missing: [route] };
  }
  const entry = result.verified[0];
  try {
    const stat = await lstat(entry.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_COMPRESSED)
      throw new Error('unsafe_or_oversized_shard');
    const raw = await readFile(entry.path);
    if (raw.length > MAX_COMPRESSED || createHash('sha256').update(raw).digest('hex') !== entry.sha256)
      throw new Error('shard_changed_after_verification');
    const unpacked = gunzipSync(raw, { maxOutputLength: MAX_JSON });
    if (unpacked.length > MAX_JSON) throw new Error('oversized_shard_json');
    const payload = JSON.parse(unpacked.toString('utf8'));
    if (!plainObject(payload)) throw new Error('unexpected_shard_shape');
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'invalid_or_changed_shard', missing: [route] };
  }
}

/**
 * A truthful, limited preview. Caller supplies validated local fingerprints,
 * produced independently by the published skilllineage fingerprint command.
 *
 * Positive exact/same-instructions evidence is checked against pinned synthetic
 * shards. If neither tier matches, variants are NOT evaluated, hence the result
 * is INDETERMINATE instead of a false global no-match.
 */
export async function previewSyntheticEvidence(session, { gitBlobSha1, instructionsSha256 }) {
  if (!isPinnedSyntheticSession(session) ||
      session.snapshotId !== 'synthetic-v1' ||
      !HEX40.test(gitBlobSha1) || !HEX64.test(instructionsSha256)) {
    return indeterminate(session?.snapshotId ?? 'untrusted', 'invalid_input_or_session', []);
  }
  const checked = [];
  const exactRoute = 'exact/' + gitBlobSha1.slice(0, 2) + '.json.gz';
  const exact = await resolveVerifiedJson(session, exactRoute);
  if (!exact.ok) return indeterminate(session.snapshotId, exact.reason, checked, exact.missing);
  checked.push(exactRoute);
  const rawEntry = Object.hasOwn(exact.payload, gitBlobSha1) ? exact.payload[gitBlobSha1] : undefined;
  if (rawEntry !== undefined) {
    if (!exactEntry(rawEntry))
      return indeterminate(session.snapshotId, 'inconsistent_exact_entry', checked);
    return checkedMatch(session.snapshotId, 'exact', checked, {
      copyCount: rawEntry.copyCount, occurrenceCount: rawEntry.occurrences.length
    });
  }
  const instrRoute = 'instructions/' + instructionsSha256.slice(0, 2) + '.json.gz';
  const instruction = await resolveVerifiedJson(session, instrRoute);
  if (!instruction.ok) return indeterminate(session.snapshotId, instruction.reason, checked, instruction.missing);
  checked.push(instrRoute);
  const rawHashes = Object.hasOwn(instruction.payload, instructionsSha256) ?
    instruction.payload[instructionsSha256] : undefined;
  if (rawHashes === undefined)
    return indeterminate(session.snapshotId, 'variant_index_not_evaluated', checked);
  if (!Array.isArray(rawHashes) || rawHashes.length < 1 || rawHashes.length > 1024 ||
      !rawHashes.every(h => typeof h === 'string' && HEX40.test(h))) {
    return indeterminate(session.snapshotId, 'inconsistent_instruction_mapping', checked);
  }
  const unique = [...new Set(rawHashes)].sort();
  const routes = [...new Set(unique.map(h => 'exact/' + h.slice(0, 2) + '.json.gz'))].sort();
  const byRoute = new Map();
  for (const route of routes) {
    const resolved = await resolveVerifiedJson(session, route);
    if (!resolved.ok) return indeterminate(session.snapshotId, resolved.reason, checked, resolved.missing);
    if (!checked.includes(route)) checked.push(route);
    byRoute.set(route, resolved.payload);
  }
  let copyCount = 0;
  for (const hash of unique) {
    const entry = byRoute.get('exact/' + hash.slice(0, 2) + '.json.gz')?.[hash];
    if (!exactEntry(entry))
      return indeterminate(session.snapshotId, 'inconsistent_instruction_to_exact_link', checked);
    copyCount += entry.copyCount;
    if (!Number.isSafeInteger(copyCount))
      return indeterminate(session.snapshotId, 'unbounded_copy_count', checked);
  }
  return checkedMatch(session.snapshotId, 'same_instructions', checked, {
    distinctBlobHashCount: unique.length, copyCount
  });
}
