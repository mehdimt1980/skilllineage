export {
  readManifest,
  readShard,
  lookupExact,
  readInstructionShard,
  lookupInstructions,
  readSketchShard,
  readAnchorShard,
  shardPrefix,
  IndexError,
} from "./reader.js";
export {
  VARIANT_SKETCH_SHARD_ROUTING,
  variantSketchRoute,
} from "./routing.js";
export type { VariantSketchRoute } from "./routing.js";
export type { ShardKind, ShardReadEvent, ShardReadObserver } from "./reader.js";
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
  VariantSketchRecord,
  SketchShard,
  AnchorShard,
} from "./types.js";
