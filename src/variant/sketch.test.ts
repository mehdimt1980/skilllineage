import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { normalizeInstructions } from "../fingerprint/index.js";
import {
  estimateSketchSimilarity,
  instructionSketch,
  shingleHash96,
  anchorShardPrefix,
  variantIdFromInstructionsSha256,
} from "./sketch.js";

describe("instructionSketch", () => {
  it("is deterministic and sorted", () => {
    const normalized = normalizeInstructions(
      "# Runner\n\nOne two three four five six seven eight nine ten.\n",
    );
    const first = instructionSketch(normalized);
    expect(instructionSketch(normalized)).toEqual(first);
    expect(first).toEqual([...first].sort());
  });

  it("treats repeated shingles as a set", () => {
    const once = normalizeInstructions("a b c d e\n");
    const repeated = normalizeInstructions("a b c d e a b c d e\n");
    expect(instructionSketch(once)).toContain(shingleHash96("a b c d e"));
    const sketch = instructionSketch(repeated);
    expect(new Set(sketch).size).toBe(sketch.length);
  });

  it("uses the whole sequence when fewer than five tokens", () => {
    expect(instructionSketch(normalizeInstructions("one two three\n"))).toEqual([
      shingleHash96("one two three"),
    ]);
  });

  it("returns an empty sketch for an empty body", () => {
    expect(instructionSketch(normalizeInstructions(""))).toEqual([]);
  });

  it("is unchanged by frontmatter-only differences", () => {
    const a = normalizeInstructions("---\nname: a\n---\n# Skill\nDo this now.\n");
    const b = normalizeInstructions("---\nname: b\n---\n# Skill\nDo this now.\n");
    expect(instructionSketch(a)).toEqual(instructionSketch(b));
  });

  it("is unchanged by CRLF/LF differences", () => {
    const lf = normalizeInstructions("# Skill\nOne two three four five.\n");
    const crlf = normalizeInstructions("# Skill\r\nOne two three four five.\r\n");
    expect(instructionSketch(lf)).toEqual(instructionSketch(crlf));
  });

  it("small edits retain shared anchors", () => {
    const a = instructionSketch(normalizeInstructions(
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen\n",
    ));
    const b = instructionSketch(normalizeInstructions(
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen changed\n",
    ));
    expect(a.slice(0, 8).filter((hash) => b.includes(hash)).length).toBeGreaterThanOrEqual(2);
  });
});

describe("anchorShardPrefix", () => {
  it("is deterministic and hashes anchor hex instead of taking its prefix", () => {
    const anchor = "19a4dd78f21b72c5191c388a";
    expect(anchorShardPrefix(anchor)).toBe(anchorShardPrefix(anchor));
    expect(anchorShardPrefix(anchor)).toMatch(/^[0-9a-f]{2}$/);
    expect(anchorShardPrefix(anchor)).toBe(createHash("sha256").update(anchor, "utf-8").digest("hex").slice(0, 2));
  });
  it("distributes distinct anchor values without modifying them", () => {
    const anchors = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(24, "0"));
    expect(new Set(anchors.map(anchorShardPrefix)).size).toBeGreaterThan(1);
    expect(anchors[0]).toBe("000000000000000000000000");
  });
});

describe("estimateSketchSimilarity", () => {
  it("is symmetric", () => {
    const a = ["01", "03", "08"];
    const b = ["01", "04", "08"];
    expect(estimateSketchSimilarity(a, b)).toBe(estimateSketchSimilarity(b, a));
  });

  it("estimates identical sketches as 1", () => {
    expect(estimateSketchSimilarity(["01", "02"], ["01", "02"])).toBe(1);
  });

  it("handles empty sketches", () => {
    expect(estimateSketchSimilarity([], [])).toBe(1);
    expect(estimateSketchSimilarity([], ["01"])).toBe(0);
  });
});

describe("variantId", () => {
  it("is the first 24 hex characters of the full instruction hash", () => {
    expect(
      variantIdFromInstructionsSha256(
        "sha256:a556b049c00e46752a2093093f300d237a98c1c5e196f644b73a2931045dbecf",
      ),
    ).toBe("a556b049c00e46752a209309");
  });
});
