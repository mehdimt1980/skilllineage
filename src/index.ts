/**
 * SkillLineage — public API surface.
 *
 * Re-exports intended for programmatic consumers
 * (GitHub Actions, web APIs, other Node apps).
 */
export { VERSION } from "./cli/app.js";
export {
  fingerprint,
  FingerprintError,
  normalizeInstructions,
  computeGitBlobSha1,
} from "./fingerprint/index.js";
export type {
  FingerprintReport,
  ToolMeta,
  SkillMeta,
  Fingerprints,
  InventoryFile,
  Inventory,
} from "./fingerprint/index.js";
export { compareSkills, instructionSimilarity } from "./compare/index.js";
export type { CompareReport, Relation } from "./compare/index.js";
export {
  readManifest,
  readShard,
  lookupExact,
  readInstructionShard,
  lookupInstructions,
  readAnchorShard,
  readSketchShard,
  shardPrefix,
  VARIANT_SKETCH_SHARD_ROUTING,
  variantSketchRoute,
  IndexError,
} from "./index/index.js";
export type {
  IndexManifest,
  IndexSource,
  IndexDescriptors,
  IndexDescriptor,
  InstructionIndexStats,
  IndexOccurrence,
  IndexHashEntry,
  IndexShard,
  InstructionShard,
  VariantIndexDescriptor,
  SketchShard,
  AnchorShard,
  VariantSketchRecord,
  VariantSketchRoute,
} from "./index/index.js";
export {
  estimateSketchSimilarity,
  instructionSketch,
  shingleHash96,
  variantIdFromInstructionsSha256,
} from "./variant/index.js";
export { traceSkill, TraceError } from "./trace/index.js";
export type {
  TraceReport,
  TraceQuery,
  TraceMatch,
  ExactMatch,
  SameInstructionsMatch,
  VariantCandidatesMatch,
  VariantCandidate,
  VariantCandidateExample,
  NoneMatch,
  TraceProfiling,
  TraceProfilingOptions,
} from "./trace/index.js";
