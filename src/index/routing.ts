export const VARIANT_SKETCH_SHARD_ROUTING = "variant-id-hex4-v1" as const;
export const VARIANT_ENRICHMENT_SHARD_ROUTING =
  "instructions-sha256-hex4-v1" as const;
export const EXACT_HISTORY_SHARD_ROUTING = "git-blob-sha1-hex4-v1" as const;
export const INSTRUCTION_HISTORY_SHARD_ROUTING = "instructions-sha256-hex4-v1" as const;

export interface VariantSketchRoute {
  readonly directory: string;
  readonly file: string;
  readonly key: string;
}

export interface VariantEnrichmentRoute {
  readonly directory: string;
  readonly file: string;
  readonly key: string;
}

/**
 * Route a 96-bit variant id to its schema-0.3+ sketch micro-shard.
 *
 * Example: a1b2c3... -> variants/sketches/a1/b2.json.gz
 */
export function variantSketchRoute(variantId: string): VariantSketchRoute {
  const normalized = variantId.toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(normalized)) {
    throw new Error(`Invalid variant id for sketch routing: ${variantId}`);
  }
  const directory = normalized.slice(0, 2);
  const file = normalized.slice(2, 4);
  return { directory, file, key: `${directory}/${file}` };
}

/**
 * Route a normalized-instructions SHA-256 to its schema-0.4 enrichment
 * micro-shard.
 *
 * Example: a1b2c3... -> variants/enrichment/a1/b2.json.gz
 */
export function variantEnrichmentRoute(
  instructionsSha256: string,
): VariantEnrichmentRoute {
  const normalized = instructionsSha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(
      `Invalid instructions SHA-256 for enrichment routing: ${instructionsSha256}`,
    );
  }
  const directory = normalized.slice(0, 2);
  const file = normalized.slice(2, 4);
  return { directory, file, key: `${directory}/${file}` };
}

export function exactHistoryRoute(blobSha1: string): VariantEnrichmentRoute {
  return historyRoute(blobSha1, 40, "blob SHA-1");
}

export function instructionHistoryRoute(instructionsSha256: string): VariantEnrichmentRoute {
  return historyRoute(instructionsSha256, 64, "instructions SHA-256");
}

function historyRoute(value: string, length: number, name: string): VariantEnrichmentRoute {
  const normalized = value.toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(normalized)) {
    throw new Error(`Invalid ${name} for history routing: ${value}`);
  }
  const directory = normalized.slice(0, 2);
  const file = normalized.slice(2, 4);
  return { directory, file, key: `${directory}/${file}` };
}
