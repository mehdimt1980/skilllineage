import { describe, expect, it } from "vitest";

import {
  VARIANT_SKETCH_SHARD_ROUTING,
  variantSketchRoute,
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
  });

  it("declares the schema-0.3 routing identifier", () => {
    expect(VARIANT_SKETCH_SHARD_ROUTING).toBe("variant-id-hex4-v1");
  });
});
