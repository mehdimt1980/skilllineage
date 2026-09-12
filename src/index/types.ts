/**
 * Index format types for the SkillLineage dual index.
 *
 * Derived from GitSkills — does NOT contain Skill content.
 */

export interface IndexManifest {
  readonly schemaVersion: "0.2";
  readonly kind: "skilllineage-exact-index";
  readonly source: IndexSource;
  readonly indexes: IndexDescriptors;
  readonly recordCount: number;
  readonly distinctHashCount: number;
  readonly instructionIndex: InstructionIndexStats;
  readonly variantIndex: VariantIndexDescriptor;
}

export interface IndexSource {
  readonly name: string;
  readonly snapshot: string;
  readonly license: string;
  readonly url: string;
}

export interface IndexDescriptors {
  readonly exact: IndexDescriptor;
  readonly instructions: IndexDescriptor;
}

export interface IndexDescriptor {
  readonly algorithm: string;
  readonly shardPrefixLength: 2;
}

export interface InstructionIndexStats {
  readonly indexedDistinctContentCount: number;
  readonly skippedDistinctContentCount: number;
}

export interface VariantIndexDescriptor {
  readonly algorithm: "bottom-k-token-shingles-v1";
  readonly shingleSize: 5;
  readonly shingleHash: "sha256-96";
  readonly sketchSize: 32;
  readonly anchorCount: 8;
  readonly maxAnchorPostings: 2000;
  readonly anchorShardRouting: "sha256-anchor-hex-v1";
  readonly skippedHotAnchorCount: number;
}

export interface IndexOccurrence {
  readonly repoFullName: string;
  readonly path: string;
  readonly locationClass: string | null;
  readonly stars: number | null;
  readonly firstCommitAt: string | null;
  readonly lastCommitAt: string | null;
  readonly historyFetched: boolean | null;
}

export interface IndexHashEntry {
  readonly copyCount: number;
  readonly occurrences: readonly IndexOccurrence[];
}

/**
 * A shard is a mapping from full hex SHA-1 to its hash entry.
 * Keys are 40-char lowercase hex (no prefix).
 */
export type IndexShard = Record<string, IndexHashEntry>;

/**
 * An instruction shard maps instruction SHA-256 hex (64 char, no prefix)
 * to a sorted list of git blob SHA-1 hex strings (40 char, no prefix).
 */
export type InstructionShard = Record<string, string[]>;

export interface VariantSketchRecord {
  readonly instructionsSha256: string;
  readonly sketch: readonly string[];
}

export type SketchShard = Record<string, VariantSketchRecord>;
export type AnchorShard = Record<string, string[]>;
