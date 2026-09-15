import { describe, expect, it } from "vitest";

import {
  generateVariantCandidates,
  scoreVariantCandidates,
} from "./lookup.js";
import { anchorShardPrefix } from "./sketch.js";
import { variantSketchRoute } from "../index/routing.js";
import type { AnchorShard, SketchShard } from "../index/types.js";

describe("variant candidate generation", () => {
  it("reads each anchor shard once and counts shared anchors", async () => {
    const local = ["aa00", "aa01", "bb00"];
    const reads = new Map<string, number>();
    const shards: Record<string, AnchorShard> = {};
    for (const [anchor, postings] of Object.entries({ aa00: ["v1", "v2"], aa01: ["v1"], bb00: ["v1", "v2"] })) {
      const prefix = anchorShardPrefix(anchor);
      (shards[prefix] ??= {})[anchor] = postings;
    }
    const result = await generateVariantCandidates(local, (prefix) => {
      reads.set(prefix, (reads.get(prefix) ?? 0) + 1);
      return Promise.resolve(shards[prefix] ?? {});
    });
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect([...reads.keys()].sort()).toEqual([...new Set(local.map(anchorShardPrefix))].sort());
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

  it("reports candidate and scoring diagnostic counts", async () => {
    const generation = { observedCandidateCount: 0, eligibleCandidateCount: 0, returnedCandidateCount: 0, uniqueAnchorShardCount: 0 };
    const anchorA = "aa00";
    const anchorB = "bb00";
    const variantId = "ccdd" + "0".repeat(20);
    const generated = await generateVariantCandidates([anchorA, anchorB], (prefix) => Promise.resolve({
      ...(prefix === anchorShardPrefix(anchorA) ? { [anchorA]: [variantId] } : {}),
      ...(prefix === anchorShardPrefix(anchorB) ? { [anchorB]: [variantId] } : {}),
    }), generation);
    expect(generation.observedCandidateCount).toBe(1);
    expect(generation.eligibleCandidateCount).toBe(1);
    const scoring = { inputCandidateCount: 0, uniqueSketchShardCount: 0, sketchRecordsFound: 0, passedEstimatedThresholdCount: 0, finalCandidateCount: 0 };
    await scoreVariantCandidates([anchorA, anchorB], generated.candidates, () => Promise.resolve({ [variantId]: { instructionsSha256: "d".repeat(64), sketch: [anchorA, anchorB] } }), scoring);
    expect(scoring.inputCandidateCount).toBe(1);
    expect(scoring.uniqueSketchShardCount).toBe(1);
    expect(scoring.sketchRecordsFound).toBe(1);
    expect(scoring.passedEstimatedThresholdCount).toBe(1);
  });

  it("caps pre-score candidates at 2000 and reports truncation", async () => {
    const postings = Array.from({ length: 2001 }, (_, i) =>
      i.toString(16).padStart(24, "0"),
    );
    const result = await generateVariantCandidates(["aa00", "bb00"], (prefix) =>
      Promise.resolve({ ...(prefix === anchorShardPrefix("aa00") ? { aa00: postings } : {}),
        ...(prefix === anchorShardPrefix("bb00") ? { bb00: postings } : {}) }),
    );
    expect(result.candidates).toHaveLength(2000);
    expect(result.truncated).toBe(true);
  });
});

describe("variant candidate scoring", () => {
  it("reads each four-hex sketch route once and sorts deterministically", async () => {
    const local = ["01", "02", "03", "04"];
    const candidates = [
      { variantId: "aa00" + "0".repeat(20), sharedAnchors: 2 },
      { variantId: "aa00" + "1".repeat(20), sharedAnchors: 3 },
      { variantId: "aa10" + "0".repeat(20), sharedAnchors: 2 },
    ];
    const reads = new Map<string, number>();
    const records: SketchShard = Object.fromEntries(candidates.map((candidate, i) => [
      candidate.variantId,
      {
        instructionsSha256: `${i}`.repeat(64),
        sketch: local,
      },
    ]));
    const result = await scoreVariantCandidates(local, candidates, (routeKey) => {
      reads.set(routeKey, (reads.get(routeKey) ?? 0) + 1);
      return Promise.resolve(records);
    });
    expect(reads).toEqual(new Map([["aa/00", 1], ["aa/10", 1]]));
    expect(result.map((candidate) => candidate.sharedAnchors)).toEqual([3, 2, 2]);
  });

  it("uses exactly the routing helper output for physical reads", async () => {
    const candidates = [
      { variantId: "a1b2" + "0".repeat(20), sharedAnchors: 2 },
      { variantId: "a1b2" + "1".repeat(20), sharedAnchors: 2 },
      { variantId: "a1c3" + "2".repeat(20), sharedAnchors: 2 },
    ];
    const observed: string[] = [];
    const shard: SketchShard = Object.fromEntries(candidates.map((candidate, index) => [candidate.variantId, {
      instructionsSha256: index.toString(16).padStart(64, "0"),
      sketch: ["01", "02"],
    }]));
    await scoreVariantCandidates(["01", "02"], candidates, (routeKey) => {
      observed.push(routeKey);
      return Promise.resolve(shard);
    });
    expect(observed).toEqual([
      variantSketchRoute(candidates[0].variantId).key,
      variantSketchRoute(candidates[2].variantId).key,
    ]);
  });

  it("filters clearly unrelated sketches", async () => {
    const result = await scoreVariantCandidates(
      ["01", "02", "03"],
      [{ variantId: "aa00" + "0".repeat(20), sharedAnchors: 2 }],
      () => Promise.resolve({
        ["aa00" + "0".repeat(20)]: {
          instructionsSha256: "f".repeat(64),
          sketch: ["90", "91", "92"],
        },
      }),
    );
    expect(result).toEqual([]);
  });

  it("preserves similarity, tie-breaking, and final ordering", async () => {
    const local = ["01", "02", "03", "04"];
    const candidates = [
      { variantId: "1100" + "a".repeat(20), sharedAnchors: 2 },
      { variantId: "2200" + "b".repeat(20), sharedAnchors: 3 },
      { variantId: "3300" + "c".repeat(20), sharedAnchors: 2 },
    ];
    const records: SketchShard = {
      [candidates[0].variantId]: { instructionsSha256: "2".repeat(64), sketch: local },
      [candidates[1].variantId]: { instructionsSha256: "3".repeat(64), sketch: local },
      [candidates[2].variantId]: { instructionsSha256: "1".repeat(64), sketch: local },
    };
    const result = await scoreVariantCandidates(local, candidates, () => Promise.resolve(records));
    expect(result.map((candidate) => candidate.sharedAnchors)).toEqual([3, 2, 2]);
    expect(result.map((candidate) => candidate.estimatedSimilarity)).toEqual([1, 1, 1]);
    expect(result.slice(1).map((candidate) => candidate.instructionsSha256)).toEqual(["1".repeat(64), "2".repeat(64)]);
  });

  it("caps final results at 10", async () => {
    const local = ["01", "02"];
    const candidates = Array.from({ length: 12 }, (_, i) => ({
      variantId: `aa${i.toString(16).padStart(2, "0")}${"0".repeat(20)}`,
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
