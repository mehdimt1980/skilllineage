import { describe, expect, it } from "vitest";

import {
  generateVariantCandidates,
  scoreVariantCandidates,
} from "./lookup.js";
import type { AnchorShard, SketchShard } from "../index/types.js";

describe("variant candidate generation", () => {
  it("reads each anchor shard once and counts shared anchors", async () => {
    const local = ["aa00", "aa01", "bb00"];
    const reads = new Map<string, number>();
    const result = await generateVariantCandidates(local, (prefix) => {
      reads.set(prefix, (reads.get(prefix) ?? 0) + 1);
      const shard: AnchorShard = prefix === "aa"
        ? { aa00: ["v1", "v2"], aa01: ["v1"] }
        : { bb00: ["v1", "v2"] };
      return Promise.resolve(shard);
    });
    expect(reads).toEqual(new Map([["aa", 1], ["bb", 1]]));
    expect(result.candidates).toEqual([
      { variantId: "v1", sharedAnchors: 3 },
      { variantId: "v2", sharedAnchors: 2 },
    ]);
  });

  it("rejects candidates below two shared anchors before scoring", async () => {
    const result = await generateVariantCandidates(["aa00"], () =>
      Promise.resolve({ aa00: ["only-one"] }),
    );
    expect(result.candidates).toEqual([]);
  });

  it("caps pre-score candidates at 2000 and reports truncation", async () => {
    const postings = Array.from({ length: 2001 }, (_, i) =>
      i.toString(16).padStart(24, "0"),
    );
    const result = await generateVariantCandidates(["aa00", "bb00"], (prefix) =>
      Promise.resolve(prefix === "aa" ? { aa00: postings } : { bb00: postings }),
    );
    expect(result.candidates).toHaveLength(2000);
    expect(result.truncated).toBe(true);
  });
});

describe("variant candidate scoring", () => {
  it("reads each sketch shard once and sorts deterministically", async () => {
    const local = ["01", "02", "03", "04"];
    const candidates = [
      { variantId: "aa0000000000000000000000", sharedAnchors: 2 },
      { variantId: "aa1000000000000000000000", sharedAnchors: 3 },
      { variantId: "bb0000000000000000000000", sharedAnchors: 2 },
    ];
    const reads = new Map<string, number>();
    const records: SketchShard = Object.fromEntries(candidates.map((candidate, i) => [
      candidate.variantId,
      {
        instructionsSha256: `${i}`.repeat(64),
        sketch: local,
      },
    ]));
    const result = await scoreVariantCandidates(local, candidates, (prefix) => {
      reads.set(prefix, (reads.get(prefix) ?? 0) + 1);
      return Promise.resolve(records);
    });
    expect(reads).toEqual(new Map([["aa", 1], ["bb", 1]]));
    expect(result.map((candidate) => candidate.sharedAnchors)).toEqual([3, 2, 2]);
  });

  it("filters clearly unrelated sketches", async () => {
    const result = await scoreVariantCandidates(
      ["01", "02", "03"],
      [{ variantId: "aa0000000000000000000000", sharedAnchors: 2 }],
      () => Promise.resolve({
        aa0000000000000000000000: {
          instructionsSha256: "f".repeat(64),
          sketch: ["90", "91", "92"],
        },
      }),
    );
    expect(result).toEqual([]);
  });

  it("caps final results at 10", async () => {
    const local = ["01", "02"];
    const candidates = Array.from({ length: 12 }, (_, i) => ({
      variantId: `aa${i.toString(16).padStart(22, "0")}`,
      sharedAnchors: 2,
    }));
    const shard: SketchShard = Object.fromEntries(candidates.map((candidate, i) => [
      candidate.variantId,
      { instructionsSha256: i.toString(16).padStart(64, "0"), sketch: local },
    ]));
    expect(await scoreVariantCandidates(local, candidates, () => Promise.resolve(shard)))
      .toHaveLength(10);
  });
});
