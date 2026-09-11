import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { compareSkills } from "./compare.js";
import {
  instructionSimilarity,
  tokenize,
  shingleSet,
  jaccardSimilarity,
} from "./similarity.js";
import { normalizeInstructions } from "../fingerprint/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

async function makeTempSkill(
  files: Record<string, string | Buffer>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skilllineage-cmp-"));
  tempDirs.push(dir);

  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(
      abs,
      typeof content === "string" ? Buffer.from(content, "utf-8") : content,
    );
  }

  return dir;
}

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true });
  }
});

const TOOL_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Relation classification
// ---------------------------------------------------------------------------

describe("relation classification", () => {
  it("identical copied bundles → identical_bundle", async () => {
    const files = {
      "SKILL.md": "---\nname: skill\n---\n# Hello\n\nDo the thing.\n",
      "scripts/run.sh": "#!/bin/bash\necho hello\n",
    };
    const dirA = await makeTempSkill(files);
    const dirB = await makeTempSkill(files);

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(report.relation).toBe("identical_bundle");
    expect(report.identity.sameBundle).toBe(true);
    expect(report.identity.sameSkillMd).toBe(true);
    expect(report.identity.sameInstructions).toBe(true);
    expect(report.similarity.instructions).toBe(1);
  });

  it("same SKILL.md but changed supporting file → same_skill_md", async () => {
    const dirA = await makeTempSkill({
      "SKILL.md": "# Skill\n\nInstructions here.\n",
      "data.txt": "version 1\n",
    });
    const dirB = await makeTempSkill({
      "SKILL.md": "# Skill\n\nInstructions here.\n",
      "data.txt": "version 2\n",
    });

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(report.relation).toBe("same_skill_md");
    expect(report.identity.sameBundle).toBe(false);
    expect(report.identity.sameSkillMd).toBe(true);
    expect(report.identity.sameInstructions).toBe(true);
  });

  it("changed frontmatter only → same_instructions", async () => {
    const dirA = await makeTempSkill({
      "SKILL.md": "---\nname: skill-a\n---\n# Skill\n\nDo the thing.\n",
    });
    const dirB = await makeTempSkill({
      "SKILL.md":
        "---\nname: skill-b\nauthor: someone\n---\n# Skill\n\nDo the thing.\n",
    });

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(report.relation).toBe("same_instructions");
    expect(report.identity.sameSkillMd).toBe(false);
    expect(report.identity.sameInstructions).toBe(true);
  });

  it("CRLF/LF-only instruction difference → same_instructions", async () => {
    const dirA = await makeTempSkill({
      "SKILL.md": "# Skill\n\nLine one.\nLine two.\n",
    });
    const dirB = await makeTempSkill({
      "SKILL.md": "# Skill\r\n\r\nLine one.\r\nLine two.\r\n",
    });

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(report.relation).toBe("same_instructions");
    expect(report.identity.sameSkillMd).toBe(false);
    expect(report.identity.sameInstructions).toBe(true);
  });

  it("small instruction edit with similarity >= 0.70 → variant", async () => {
    // ~20 tokens, change just the last few — most 5-shingles will overlap
    const base =
      "# Task Runner\n\nThis skill runs automated tasks on behalf of the user.\nIt supports scheduling, retries, and error handling.\nThe output is a structured JSON report.\n";
    const variant =
      "# Task Runner\n\nThis skill runs automated tasks on behalf of the user.\nIt supports scheduling, retries, and error handling.\nThe output is a structured XML report.\n";

    const dirA = await makeTempSkill({ "SKILL.md": base });
    const dirB = await makeTempSkill({ "SKILL.md": variant });

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(report.relation).toBe("variant");
    expect(report.similarity.instructions).toBeGreaterThanOrEqual(0.7);
    expect(report.similarity.instructions).toBeLessThan(1);
  });

  it("substantially unrelated instructions → different", async () => {
    const dirA = await makeTempSkill({
      "SKILL.md":
        "# Image Processor\n\nThis skill resizes and crops images.\nIt supports PNG, JPEG, and WebP formats.\nOutput is saved to the configured directory.\n",
    });
    const dirB = await makeTempSkill({
      "SKILL.md":
        "# Database Migrator\n\nThis skill manages database schema migrations.\nIt supports PostgreSQL and MySQL.\nRollback is automatic on failure.\n",
    });

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(report.relation).toBe("different");
    expect(report.similarity.instructions).toBeLessThan(0.7);
  });
});

// ---------------------------------------------------------------------------
// File diff
// ---------------------------------------------------------------------------

describe("file diff", () => {
  it("detects added files", async () => {
    const dirA = await makeTempSkill({
      "SKILL.md": "# Skill\n",
    });
    const dirB = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "references/new.md": "# New\n",
    });

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(report.files.added).toEqual(["references/new.md"]);
  });

  it("detects removed files", async () => {
    const dirA = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "old.txt": "old content\n",
    });
    const dirB = await makeTempSkill({
      "SKILL.md": "# Skill\n",
    });

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(report.files.removed).toEqual(["old.txt"]);
  });

  it("detects modified files", async () => {
    const dirA = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "scripts/run.sh": "echo v1\n",
    });
    const dirB = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "scripts/run.sh": "echo v2\n",
    });

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(report.files.modified).toEqual(["scripts/run.sh"]);
  });

  it("detects unchanged files", async () => {
    const dirA = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "assets/template.txt": "shared\n",
    });
    const dirB = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "assets/template.txt": "shared\n",
    });

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(report.files.unchanged).toContain("assets/template.txt");
    expect(report.files.unchanged).toContain("SKILL.md");
  });

  it("file lists are sorted by code-point order", async () => {
    const dirA = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "b.txt": "b\n",
      "a.txt": "a\n",
    });
    const dirB = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "b.txt": "b\n",
      "a.txt": "a\n",
    });

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(report.files.unchanged).toEqual([
      "SKILL.md",
      "a.txt",
      "b.txt",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Determinism and symmetry
// ---------------------------------------------------------------------------

describe("determinism and symmetry", () => {
  it("comparison is deterministic", async () => {
    const dirA = await makeTempSkill({
      "SKILL.md": "# Skill A\n\nDo something.\n",
    });
    const dirB = await makeTempSkill({
      "SKILL.md": "# Skill B\n\nDo something different.\n",
    });

    const r1 = await compareSkills(dirA, dirB, TOOL_VERSION);
    const r2 = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(r1).toEqual(r2);
  });

  it("similarity is symmetric: sim(A,B) === sim(B,A)", async () => {
    const dirA = await makeTempSkill({
      "SKILL.md":
        "# Task Runner\n\nThis skill runs automated tasks on behalf of the user.\nIt supports scheduling and retries.\n",
    });
    const dirB = await makeTempSkill({
      "SKILL.md":
        "# Task Runner\n\nThis skill runs automated tasks on behalf of the user.\nIt supports scheduling and error handling.\n",
    });

    const rAB = await compareSkills(dirA, dirB, TOOL_VERSION);
    const rBA = await compareSkills(dirB, dirA, TOOL_VERSION);

    expect(rAB.similarity.instructions).toBe(rBA.similarity.instructions);
  });
});

// ---------------------------------------------------------------------------
// Similarity edge cases
// ---------------------------------------------------------------------------

describe("similarity edge cases", () => {
  it("both empty instruction bodies → similarity 1", () => {
    const normA = normalizeInstructions("");
    const normB = normalizeInstructions("");
    expect(instructionSimilarity(normA, normB)).toBe(1);
  });

  it("one empty body → similarity 0", () => {
    const normA = normalizeInstructions("# Some real content here.\n");
    const normB = normalizeInstructions("");
    expect(instructionSimilarity(normA, normB)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tokenization unit tests
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("hello world\n")).toEqual(["hello", "world"]);
  });

  it("removes empty tokens", () => {
    expect(tokenize("hello   world\n")).toEqual(["hello", "world"]);
  });

  it("preserves case and punctuation", () => {
    expect(tokenize("Hello, World!\n")).toEqual(["Hello,", "World!"]);
  });

  it("handles empty input", () => {
    expect(tokenize("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shingle unit tests
// ---------------------------------------------------------------------------

describe("shingleSet", () => {
  it("produces correct 5-token shingles", () => {
    const tokens = ["one", "two", "three", "four", "five", "six"];
    const shingles = shingleSet(tokens);
    expect(shingles).toEqual(
      new Set(["one two three four five", "two three four five six"]),
    );
  });

  it("uses whole sequence as single shingle when < 5 tokens", () => {
    const tokens = ["a", "b", "c"];
    const shingles = shingleSet(tokens);
    expect(shingles).toEqual(new Set(["a b c"]));
  });

  it("returns empty set for empty input", () => {
    expect(shingleSet([])).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// Jaccard unit tests
// ---------------------------------------------------------------------------

describe("jaccardSimilarity", () => {
  it("identical sets → 1", () => {
    const s = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it("disjoint sets → 0", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["c", "d"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("both empty → 1", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it("one empty → 0", () => {
    expect(jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
  });

  it("partial overlap computed correctly", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    // intersection: {b, c} = 2, union: {a,b,c,d} = 4
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Report structure
// ---------------------------------------------------------------------------

describe("report structure", () => {
  it("includes correct schema version and tool metadata", async () => {
    const dirA = await makeTempSkill({ "SKILL.md": "# Skill\n" });
    const dirB = await makeTempSkill({ "SKILL.md": "# Skill\n" });

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    expect(report.schemaVersion).toBe("0.1");
    expect(report.tool.name).toBe("skilllineage");
    expect(report.tool.version).toBe(TOOL_VERSION);
  });

  it("similarity is rounded to 4 decimal places", async () => {
    const dirA = await makeTempSkill({
      "SKILL.md":
        "# Skill\n\nOne two three four five six seven eight nine ten.\n",
    });
    const dirB = await makeTempSkill({
      "SKILL.md":
        "# Skill\n\nOne two three four five six seven eight nine eleven.\n",
    });

    const report = await compareSkills(dirA, dirB, TOOL_VERSION);

    const str = String(report.similarity.instructions);
    const decimals = str.includes(".") ? str.split(".")[1] ?? "" : "";
    expect(decimals.length).toBeLessThanOrEqual(4);
  });
});
