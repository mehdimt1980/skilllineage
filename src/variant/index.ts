export {
  DEFAULT_ANCHOR_COUNT,
  DEFAULT_SKETCH_SIZE,
  SHINGLE_HASH_HEX_LENGTH,
  SHINGLE_SIZE,
  estimateSketchSimilarity,
  instructionSketch,
  shingleHash96,
  anchorShardPrefix,
  variantIdFromInstructionsSha256,
} from "./sketch.js";
export {
  MAX_FINAL_CANDIDATES,
  MAX_PRE_SCORE_CANDIDATES,
  MIN_ESTIMATED_SIMILARITY,
  MIN_SHARED_ANCHORS,
  generateVariantCandidates,
  scoreVariantCandidates,
} from "./lookup.js";
export type {
  CandidateGenerationResult,
  PreScoreCandidate,
  ScoredCandidate,
  CandidateGenerationDiagnostics,
  ScoringDiagnostics,
} from "./lookup.js";
