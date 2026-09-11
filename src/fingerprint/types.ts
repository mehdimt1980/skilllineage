/**
 * Fingerprint report schema for SkillLineage v0.1.
 *
 * All SHA-256 digests are serialized with the "sha256:" prefix.
 */

export interface FingerprintReport {
  readonly schemaVersion: "0.1";
  readonly tool: ToolMeta;
  readonly skill: SkillMeta;
  readonly fingerprints: Fingerprints;
  readonly inventory: Inventory;
}

export interface ToolMeta {
  readonly name: "skilllineage";
  readonly version: string;
}

export interface SkillMeta {
  readonly entrypoint: "SKILL.md";
}

export interface Fingerprints {
  /** SHA-256 of the exact raw bytes of the root SKILL.md. */
  readonly skillMdSha256: string;
  /** Git blob object SHA-1 of the root SKILL.md (matches git hash-object). */
  readonly gitBlobSha1: string;
  /** SHA-256 of the normalized instruction body (frontmatter stripped). */
  readonly instructionsSha256: string;
  /** SHA-256 of the deterministic bundle (all files, sorted). */
  readonly bundleSha256: string;
}

export interface InventoryFile {
  /** POSIX-style relative path from the skill root. */
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface Inventory {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly InventoryFile[];
}
