export const VARIANT_SKETCH_SHARD_ROUTING = "variant-id-hex4-v1" as const;

export interface VariantSketchRoute {
  readonly directory: string;
  readonly file: string;
  readonly key: string;
}

/**
 * Route a 96-bit variant id to its schema-0.3 sketch micro-shard.
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
