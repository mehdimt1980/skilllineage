import { describe, expect, it } from "vitest";

import {
  generateVariantCandidates,
  scoreVariantCandidates,
} from "./lookup.js";
import { anchorShardPrefix } from "./sketch.js";
import type { AnchorShard, SketchShard } from "../index/types.js";

describe("variant profiling diagnostics", () => {
  it("reports generation counts including returned count", async () => {
    const first = "aa00";
    const second = "bb00";
    const variantId = "cc".repeat(12);
    const diagnostics = {
      observedCandidateCount: 0,
      eligibleCandidateCount: 0,
      returnedCandidateCount: 0,
      uniqueAnchorShardCount: 0,
    };

    const result = await generateVariantCandidates(
      [first, second],
      (prefix) => {
        const shard: AnchorShard = {};
        if (prefix === anchorShardPrefix(first)) shard[first] = [variantId];
        if (prefix === anchorShardPrefix(second)) shard[second] = [variantId];
        return Promise.resolve(shard);
      },
      diagnostics,
    );

    expect(result.candidates).toHaveLength(1);
    expect(diagnostics).toEqual({
      observedCandidateCount: 1,
      eligibleCandidateCount: 1,
      returnedCandidateCount: 1,
      uniqueAnchorShardCount: 2,
    });
  });

  it("reports the 2000 pre-score cap without changing truncation semantics", async () => {
    const first = "aa00";
    const second = "bb00";
    const postings = Array.from({ length: 2001 }, (_, index) =>
      index.toString(16).padStart(24, "0"),
    );
    const diagnostics = {
      observedCandidateCount: 0,
      eligibleCandidateCount: 0,
      returnedCandidateCount: 0,
      uniqueAnchorShardCount: 0,
    };

    const result = await generateVariantCandidates(
      [first, second],
      (prefix) => {
        const shard: AnchorShard = {};
        if (prefix === anchorShardPrefix(first)) shard[first] = postings;
        if (prefix === anchorShardPrefix(second)) shard[second] = postings;
        return Promise.resolve(shard);
      },
      diagnostics,
    );

    expect(result.truncated).toBe(true);
    expect(result.candidates).toHaveLength(2000);
    expect(diagnostics.observedCandidateCount).toBe(2001);
    expect(diagnostics.eligibleCandidateCount).toBe(2001);
    expect(diagnostics.returnedCandidateCount).toBe(2000);
  });

  it("reports scoring records, threshold passes, and final top-10 count", async () => {
    const local = ["01", "02"];
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      variantId: `aa${index.toString(16).padStart(22, "0")}`,
      sharedAnchors: 2,
    }));
    const shard: SketchShard = Object.fromEntries(
      candidates.map((candidate, index) => [
        candidate.variantId,
        {
          instructionsSha256: index.toString(16).padStart(64, "0"),
          sketch: local,
        },
      ]),
    );
    const diagnostics = {
      inputCandidateCount: 0,
      uniqueSketchShardCount: 0,
      sketchRecordsFound: 0,
      passedEstimatedThresholdCount: 0,
      finalCandidateCount: 0,
    };

    const result = await scoreVariantCandidates(
      local,
      candidates,
      () => Promise.resolve(shard),
      diagnostics,
    );

    expect(result).toHaveLength(10);
    expect(diagnostics).toEqual({
      inputCandidateCount: 12,
      uniqueSketchShardCount: 1,
      sketchRecordsFound: 12,
      passedEstimatedThresholdCount: 12,
      finalCandidateCount: 10,
    });
  });
});
