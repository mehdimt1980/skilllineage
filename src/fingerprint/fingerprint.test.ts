import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  fingerprint,
  FingerprintError,
  normalizeInstructions,
} from "./fingerprint.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

async function makeTempSkill(
  files: Record<string, string | Buffer>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skilllineage-test-"));
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

// ---------------------------------------------------------------------------
// Deterministic fingerprinting
// ---------------------------------------------------------------------------

describe("fingerprint determinism", () => {
  it("produces identical output for the same input", async () => {
    const dir = await makeTempSkill({
      "SKILL.md": "# Hello\n\nThis is a skill.\n",
    });

    const r1 = await fingerprint(dir, "0.1.0");
    const r2 = await fingerprint(dir, "0.1.0");

    expect(r1).toEqual(r2);
  });

  it("same bundle in different directories produces same bundle hash", async () => {
    const files = {
      "SKILL.md": "# Skill\n\nInstructions here.\n",
      "scripts/run.sh": "#!/bin/bash\necho hello\n",
    };

    const dir1 = await makeTempSkill(files);
    const dir2 = await makeTempSkill(files);

    const r1 = await fingerprint(dir1, "0.1.0");
    const r2 = await fingerprint(dir2, "0.1.0");

    expect(r1.fingerprints.bundleSha256).toBe(r2.fingerprints.bundleSha256);
    expect(r1.fingerprints.skillMdSha256).toBe(r2.fingerprints.skillMdSha256);
    expect(r1.fingerprints.instructionsSha256).toBe(
      r2.fingerprints.instructionsSha256,
    );
  });
});

// ---------------------------------------------------------------------------
// Bundle sensitivity
// ---------------------------------------------------------------------------

describe("bundle sensitivity", () => {
  it("changing file contents changes bundle hash", async () => {
    const dir1 = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "data.txt": "version 1\n",
    });
    const dir2 = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "data.txt": "version 2\n",
    });

    const r1 = await fingerprint(dir1, "0.1.0");
    const r2 = await fingerprint(dir2, "0.1.0");

    expect(r1.fingerprints.bundleSha256).not.toBe(
      r2.fingerprints.bundleSha256,
    );
  });

  it("changing a filename changes bundle hash", async () => {
    const dir1 = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "alpha.txt": "content\n",
    });
    const dir2 = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "beta.txt": "content\n",
    });

    const r1 = await fingerprint(dir1, "0.1.0");
    const r2 = await fingerprint(dir2, "0.1.0");

    expect(r1.fingerprints.bundleSha256).not.toBe(
      r2.fingerprints.bundleSha256,
    );
  });
});

// ---------------------------------------------------------------------------
// instructionsSha256
// ---------------------------------------------------------------------------

describe("instructionsSha256", () => {
  it("CRLF vs LF produces the same hash", async () => {
    const dir1 = await makeTempSkill({
      "SKILL.md": "# Skill\n\nLine 1\nLine 2\n",
    });
    const dir2 = await makeTempSkill({
      "SKILL.md": "# Skill\r\n\r\nLine 1\r\nLine 2\r\n",
    });

    const r1 = await fingerprint(dir1, "0.1.0");
    const r2 = await fingerprint(dir2, "0.1.0");

    expect(r1.fingerprints.instructionsSha256).toBe(
      r2.fingerprints.instructionsSha256,
    );
  });

  it("frontmatter changes do not change the hash", async () => {
    const dir1 = await makeTempSkill({
      "SKILL.md": "---\nname: skill-a\n---\n# Skill\n\nInstructions.\n",
    });
    const dir2 = await makeTempSkill({
      "SKILL.md":
        "---\nname: skill-b\nversion: 2\n---\n# Skill\n\nInstructions.\n",
    });

    const r1 = await fingerprint(dir1, "0.1.0");
    const r2 = await fingerprint(dir2, "0.1.0");

    expect(r1.fingerprints.instructionsSha256).toBe(
      r2.fingerprints.instructionsSha256,
    );
  });

  it("instruction changes do change the hash", async () => {
    const dir1 = await makeTempSkill({
      "SKILL.md": "---\nname: skill\n---\n# Skill A\n\nDo thing A.\n",
    });
    const dir2 = await makeTempSkill({
      "SKILL.md": "---\nname: skill\n---\n# Skill B\n\nDo thing B.\n",
    });

    const r1 = await fingerprint(dir1, "0.1.0");
    const r2 = await fingerprint(dir2, "0.1.0");

    expect(r1.fingerprints.instructionsSha256).not.toBe(
      r2.fingerprints.instructionsSha256,
    );
  });
});

// ---------------------------------------------------------------------------
// skillMdSha256
// ---------------------------------------------------------------------------

describe("skillMdSha256", () => {
  it("raw SKILL.md changes change the hash", async () => {
    const dir1 = await makeTempSkill({
      "SKILL.md": "# Skill version 1\n",
    });
    const dir2 = await makeTempSkill({
      "SKILL.md": "# Skill version 2\n",
    });

    const r1 = await fingerprint(dir1, "0.1.0");
    const r2 = await fingerprint(dir2, "0.1.0");

    expect(r1.fingerprints.skillMdSha256).not.toBe(
      r2.fingerprints.skillMdSha256,
    );
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("fails when path does not exist", async () => {
    await expect(
      fingerprint("/nonexistent/path/abc123", "0.1.0"),
    ).rejects.toThrow(FingerprintError);
    await expect(
      fingerprint("/nonexistent/path/abc123", "0.1.0"),
    ).rejects.toThrow("does not exist");
  });

  it("fails when path is not a directory", async () => {
    const dir = await makeTempSkill({ "file.txt": "hello" });
    const filePath = path.join(dir, "file.txt");

    await expect(fingerprint(filePath, "0.1.0")).rejects.toThrow(
      FingerprintError,
    );
    await expect(fingerprint(filePath, "0.1.0")).rejects.toThrow(
      "Not a directory",
    );
  });

  it("fails when SKILL.md is missing", async () => {
    const dir = await makeTempSkill({ "README.md": "# Hello\n" });

    await expect(fingerprint(dir, "0.1.0")).rejects.toThrow(FingerprintError);
    await expect(fingerprint(dir, "0.1.0")).rejects.toThrow("No SKILL.md");
  });

  it("fails on symlinks", async () => {
    const dir = await makeTempSkill({ "SKILL.md": "# Skill\n" });
    const linkPath = path.join(dir, "link.txt");

    try {
      await symlink(path.join(dir, "SKILL.md"), linkPath);
    } catch (e: unknown) {
      // Windows requires elevated privileges for symlinks
      if (
        e instanceof Error &&
        "code" in e &&
        (e as NodeJS.ErrnoException).code === "EPERM"
      ) {
        return; // skip — cannot test symlinks without admin on Windows
      }
      throw e;
    }

    await expect(fingerprint(dir, "0.1.0")).rejects.toThrow(FingerprintError);
    await expect(fingerprint(dir, "0.1.0")).rejects.toThrow(
      "Symlinks are not supported",
    );
  });
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

describe("inventory", () => {
  it("excludes .git directory", async () => {
    const dir = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      ".git/config": "core.bare=false\n",
      ".git/HEAD": "ref: refs/heads/main\n",
    });

    const result = await fingerprint(dir, "0.1.0");

    const paths = result.inventory.files.map((f) => f.path);
    expect(paths).toEqual(["SKILL.md"]);
    expect(paths.some((p) => p.includes(".git"))).toBe(false);
  });

  it("files are sorted lexicographically by POSIX path", async () => {
    const dir = await makeTempSkill({
      "SKILL.md": "# Skill\n",
      "scripts/b.sh": "b\n",
      "scripts/a.sh": "a\n",
      "README.md": "# Readme\n",
    });

    const result = await fingerprint(dir, "0.1.0");
    const paths = result.inventory.files.map((f) => f.path);

    expect(paths).toEqual([
      "README.md",
      "SKILL.md",
      "scripts/a.sh",
      "scripts/b.sh",
    ]);
  });

  it("computes correct file count and total bytes", async () => {
    const dir = await makeTempSkill({
      "SKILL.md": "hello", // 5 bytes
      "data.txt": "world!",  // 6 bytes
    });

    const result = await fingerprint(dir, "0.1.0");

    expect(result.inventory.fileCount).toBe(2);
    expect(result.inventory.totalBytes).toBe(11);
  });

  it("per-file sha256 has correct prefix", async () => {
    const dir = await makeTempSkill({
      "SKILL.md": "# Skill\n",
    });

    const result = await fingerprint(dir, "0.1.0");

    for (const file of result.inventory.files) {
      expect(file.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(result.fingerprints.skillMdSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.fingerprints.gitBlobSha1).toMatch(/^sha1:[a-f0-9]{40}$/);
    expect(result.fingerprints.instructionsSha256).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(result.fingerprints.bundleSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// gitBlobSha1
// ---------------------------------------------------------------------------

describe("gitBlobSha1", () => {
  it("is deterministic", async () => {
    const dir = await makeTempSkill({ "SKILL.md": "# Hello\n" });
    const r1 = await fingerprint(dir, "0.1.0");
    const r2 = await fingerprint(dir, "0.1.0");
    expect(r1.fingerprints.gitBlobSha1).toBe(r2.fingerprints.gitBlobSha1);
  });

  it("changes when raw bytes change", async () => {
    const dir1 = await makeTempSkill({ "SKILL.md": "# Version 1\n" });
    const dir2 = await makeTempSkill({ "SKILL.md": "# Version 2\n" });

    const r1 = await fingerprint(dir1, "0.1.0");
    const r2 = await fingerprint(dir2, "0.1.0");

    expect(r1.fingerprints.gitBlobSha1).not.toBe(
      r2.fingerprints.gitBlobSha1,
    );
  });

  it("matches known Git blob hash for known content", async () => {
    // "hello\n" -> git hash-object produces: ce013625030ba8dba906f756967f9e9ca394464a
    // Verified: SHA1("blob 6\0hello\n") = ce013625030ba8dba906f756967f9e9ca394464a
    const dir = await makeTempSkill({ "SKILL.md": "hello\n" });
    const result = await fingerprint(dir, "0.1.0");

    expect(result.fingerprints.gitBlobSha1).toBe(
      "sha1:ce013625030ba8dba906f756967f9e9ca394464a",
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeInstructions unit tests
// ---------------------------------------------------------------------------

describe("normalizeInstructions", () => {
  it("strips UTF-8 BOM", () => {
    const result = normalizeInstructions("\uFEFF# Hello\n");
    expect(result).toBe("# Hello\n");
  });

  it("strips frontmatter and preserves body", () => {
    const result = normalizeInstructions(
      "---\nname: test\n---\n# Body\n\nContent.\n",
    );
    expect(result).toBe("# Body\n\nContent.\n");
  });

  it("removes trailing whitespace from lines", () => {
    const result = normalizeInstructions("# Hello   \nworld\t\t\n");
    expect(result).toBe("# Hello\nworld\n");
  });

  it("normalizes CRLF to LF", () => {
    const result = normalizeInstructions("# Hello\r\n\r\nWorld\r\n");
    expect(result).toBe("# Hello\n\nWorld\n");
  });

  it("removes leading and trailing blank lines", () => {
    const result = normalizeInstructions("\n\n\n# Hello\n\n\n");
    expect(result).toBe("# Hello\n");
  });

  it("ensures exactly one final newline", () => {
    const result = normalizeInstructions("# Hello");
    expect(result).toBe("# Hello\n");
  });

  it("handles file with only frontmatter (no body)", () => {
    const result = normalizeInstructions("---\nname: test\n---\n");
    // After stripping frontmatter, body is empty -> just a newline
    expect(result).toBe("\n");
  });

  it("does not lowercase text", () => {
    const result = normalizeInstructions("# HELLO World\n");
    expect(result).toBe("# HELLO World\n");
  });

  it("does not modify whitespace inside non-empty lines", () => {
    const result = normalizeInstructions("hello   world\n");
    expect(result).toBe("hello   world\n");
  });
});

// ---------------------------------------------------------------------------
// Report structure
// ---------------------------------------------------------------------------

describe("report structure", () => {
  it("includes correct schema version and tool metadata", async () => {
    const dir = await makeTempSkill({ "SKILL.md": "# Skill\n" });
    const result = await fingerprint(dir, "0.1.0");

    expect(result.schemaVersion).toBe("0.1");
    expect(result.tool.name).toBe("skilllineage");
    expect(result.tool.version).toBe("0.1.0");
    expect(result.skill.entrypoint).toBe("SKILL.md");
  });
});
