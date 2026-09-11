import { readFile } from "node:fs/promises";
import path from "node:path";

import { fingerprint, normalizeInstructions } from "../fingerprint/index.js";
import { instructionSimilarity } from "./similarity.js";
import type { FingerprintReport } from "../fingerprint/index.js";
import type { CompareReport, Relation } from "./types.js";

const VARIANT_THRESHOLD = 0.70;

/**
 * Compare two local Agent Skill directories and produce a deterministic report.
 *
 * Reuses the existing fingerprint engine for both directories.
 * Does NOT depend on CLI code.
 */
export async function compareSkills(
  pathA: string,
  pathB: string,
  toolVersion: string,
): Promise<CompareReport> {
  // Fingerprint both skills (reuses all validation / enumeration / hashing)
  const fpA = await fingerprint(pathA, toolVersion);
  const fpB = await fingerprint(pathB, toolVersion);

  // Identity checks
  const sameBundle =
    fpA.fingerprints.bundleSha256 === fpB.fingerprints.bundleSha256;
  const sameSkillMd =
    fpA.fingerprints.skillMdSha256 === fpB.fingerprints.skillMdSha256;
  const sameInstructions =
    fpA.fingerprints.instructionsSha256 === fpB.fingerprints.instructionsSha256;

  // File diff (B relative to A)
  const fileDiff = diffFiles(fpA, fpB);

  // Instruction similarity (unrounded for classification)
  let similarity: number;
  if (sameInstructions) {
    similarity = 1;
  } else {
    // Read and normalize SKILL.md from both directories
    const rawA = await readFile(
      path.resolve(pathA, "SKILL.md"),
      "utf-8",
    );
    const rawB = await readFile(
      path.resolve(pathB, "SKILL.md"),
      "utf-8",
    );
    const normA = normalizeInstructions(rawA);
    const normB = normalizeInstructions(rawB);
    similarity = instructionSimilarity(normA, normB);
  }

  // Classify relation using unrounded similarity
  const relation = classifyRelation(
    sameBundle,
    sameSkillMd,
    sameInstructions,
    similarity,
  );

  // Round similarity only at serialization time
  const roundedSimilarity = Math.round(similarity * 10000) / 10000;

  return {
    schemaVersion: "0.1",
    tool: {
      name: "skilllineage",
      version: toolVersion,
    },
    relation,
    similarity: {
      instructions: roundedSimilarity,
    },
    identity: {
      sameBundle,
      sameSkillMd,
      sameInstructions,
    },
    files: fileDiff,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyRelation(
  sameBundle: boolean,
  sameSkillMd: boolean,
  sameInstructions: boolean,
  similarity: number,
): Relation {
  if (sameBundle) return "identical_bundle";
  if (sameSkillMd) return "same_skill_md";
  if (sameInstructions) return "same_instructions";
  if (similarity >= VARIANT_THRESHOLD) return "variant";
  return "different";
}

// ---------------------------------------------------------------------------
// File diff
// ---------------------------------------------------------------------------

interface FileDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly modified: string[];
  readonly unchanged: string[];
}

const sortPaths = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

function diffFiles(fpA: FingerprintReport, fpB: FingerprintReport): FileDiff {
  const mapA = new Map(fpA.inventory.files.map((f) => [f.path, f.sha256]));
  const mapB = new Map(fpB.inventory.files.map((f) => [f.path, f.sha256]));

  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];

  // Files in A: check if removed or modified/unchanged
  for (const [filePath, hashA] of mapA) {
    const hashB = mapB.get(filePath);
    if (hashB === undefined) {
      removed.push(filePath);
    } else if (hashA === hashB) {
      unchanged.push(filePath);
    } else {
      modified.push(filePath);
    }
  }

  // Files only in B: added
  for (const filePath of mapB.keys()) {
    if (!mapA.has(filePath)) {
      added.push(filePath);
    }
  }

  added.sort(sortPaths);
  removed.sort(sortPaths);
  modified.sort(sortPaths);
  unchanged.sort(sortPaths);

  return { added, removed, modified, unchanged };
}
