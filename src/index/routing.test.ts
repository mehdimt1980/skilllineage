import { describe, expect, it } from "vitest";

import {
  VARIANT_ENRICHMENT_SHARD_ROUTING,
  VARIANT_SKETCH_SHARD_ROUTING,
  variantEnrichmentRoute,
  variantSketchRoute,
  exactHistoryRoute,
  instructionHistoryRoute,
} from "./routing.js";

describe("variantSketchRoute", () => {
  it("routes a variant id by its first four hex characters", () => {
    expect(variantSketchRoute("a1b2ffffffffffffffffffff")).toEqual({
      directory: "a1",
      file: "b2",
      key: "a1/b2",
    });
  });

  it("normalizes the physical route to lowercase", () => {
    expect(variantSketchRoute("A1B2ffffffffffffffffffff").key).toBe("a1/b2");
  });

  it("rejects malformed variant ids", () => {
    expect(() => variantSketchRoute("zzzz")).toThrow("Invalid variant id");
    expect(() => variantSketchRoute("abc")).toThrow("Invalid variant id");
    expect(() => variantSketchRoute("a".repeat(25))).toThrow("Invalid variant id");
  });

  it("keeps the Phase 10C sketch routing identifier unchanged", () => {
    expect(VARIANT_SKETCH_SHARD_ROUTING).toBe("variant-id-hex4-v1");
  });
});

describe("history routing", () => {
  it("routes full hashes by four lowercase hex characters", () => {
    expect(exactHistoryRoute("A1B2" + "f".repeat(36)).key).toBe("a1/b2");
    expect(instructionHistoryRoute("A1B2" + "f".repeat(60)).key).toBe("a1/b2");
  });

  it("rejects malformed hashes", () => {
    expect(() => exactHistoryRoute("a1b2")).toThrow("Invalid blob SHA-1");
    expect(() => instructionHistoryRoute("z".repeat(64))).toThrow("Invalid instructions SHA-256");
  });
});

describe("variantEnrichmentRoute", () => {
  const hash = "a1b2" + "f".repeat(60);

  it("routes a full instruction SHA-256 by its first four hex characters", () => {
    expect(variantEnrichmentRoute(hash)).toEqual({
      directory: "a1",
      file: "b2",
      key: "a1/b2",
    });
  });

  it("normalizes uppercase input deterministically", () => {
    expect(variantEnrichmentRoute(hash.toUpperCase()).key).toBe("a1/b2");
  });

  it("rejects short, long, and non-hex instruction hashes", () => {
    expect(() => variantEnrichmentRoute("a".repeat(63))).toThrow(
      "Invalid instructions SHA-256",
    );
    expect(() => variantEnrichmentRoute("a".repeat(65))).toThrow(
      "Invalid instructions SHA-256",
    );
    expect(() => variantEnrichmentRoute("z".repeat(64))).toThrow(
      "Invalid instructions SHA-256",
    );
  });

  it("declares the schema-0.4 enrichment routing identifier", () => {
    expect(VARIANT_ENRICHMENT_SHARD_ROUTING).toBe(
      "instructions-sha256-hex4-v1",
    );
  });
});
