#!/usr/bin/env node
// Generate a small, deterministic schema-0.5 index with synthetic evidence.
// This is a teaching fixture, NOT a GitSkills dataset or global index.
import { createHash } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

const targetArg = process.argv[2];
if (!targetArg || process.argv.length !== 3) {
  console.error("Usage: node tools/create-demo-fixture.mjs <new-output-directory>");
  process.exit(2);
}
const target = path.resolve(targetArg);
const instructionBody = "# Instructions\nSummarize the supplied text in three factual sentences.\nDo not invent details or claim unseen sources.\n";
const indexed = "---\nname: summary-skill\n---\n" + instructionBody;
const metadataEdit = "---\nname: renamed-summary-skill\n---\n" + instructionBody;
const raw = Buffer.from(indexed, "utf8");
const blobHash = createHash("sha1")
  .update(Buffer.from("blob " + raw.length + "\0"))
  .update(raw)
  .digest("hex");
const instructionsHash = createHash("sha256").update(instructionBody, "utf8").digest("hex");

const manifest = {
  schemaVersion: "0.5",
  kind: "skilllineage-exact-index",
  source: {
    name: "SkillLineage synthetic onboarding fixture",
    snapshot: "synthetic-v1",
    license: "CC0-1.0",
    url: "https://github.com/mehdimt1980/skilllineage"
  },
  indexes: {
    exact: { algorithm: "git-blob-sha1", shardPrefixLength: 2 },
    instructions: { algorithm: "normalized-instructions-sha256", shardPrefixLength: 2 }
  },
  recordCount: 1,
  distinctHashCount: 1,
  instructionIndex: { indexedDistinctContentCount: 1, skippedDistinctContentCount: 0 },
  variantIndex: {
    algorithm: "bottom-k-token-shingles-v1",
    shingleSize: 5,
    shingleHash: "sha256-96",
    sketchSize: 32,
    anchorCount: 8,
    maxAnchorPostings: 2000,
    anchorShardRouting: "sha256-anchor-hex-v1",
    sketchShardRouting: "variant-id-hex4-v1",
    enrichment: {
      algorithm: "precomputed-variant-summary-v1",
      shardRouting: "instructions-sha256-hex4-v1",
      exampleLimit: 3
    },
    skippedHotAnchorCount: 0
  },
  historyIndex: {
    algorithm: "dataset-observed-history-v1",
    exactRouting: "git-blob-sha1-hex4-v1",
    instructionRouting: "instructions-sha256-hex4-v1",
    semantics: "observed-not-origin",
    timestampNormalization: "utc-v1"
  }
};

async function writeGzip(file, obj) {
  await writeFile(file, gzipSync(Buffer.from(JSON.stringify(obj), "utf8")));
}

try {
  // Refuse to overwrite any existing directory, even an empty one.
  await mkdir(target);
} catch (error) {
  if (error?.code === "EEXIST") {
    console.error("Refusing to overwrite an existing directory: " + target);
    process.exit(1);
  }
  throw error;
}

try {
  await mkdir(path.join(target, "skills", "indexed"), { recursive: true });
  await mkdir(path.join(target, "skills", "metadata-edit"), { recursive: true });
  await mkdir(path.join(target, "index", "exact"), { recursive: true });
  await mkdir(path.join(target, "index", "instructions"), { recursive: true });
  await mkdir(path.join(target, "index", "variants", "anchors"), { recursive: true });

  await writeFile(path.join(target, "skills", "indexed", "SKILL.md"), indexed);
  await writeFile(path.join(target, "skills", "metadata-edit", "SKILL.md"), metadataEdit);
  await writeFile(path.join(target, "index", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const occurrence = {
    repoFullName: "synthetic-example/onboarding",
    path: "skills/indexed/SKILL.md",
    locationClass: "synthetic",
    stars: null,
    firstCommitAt: null,
    lastCommitAt: null,
    historyFetched: false
  };
  const exact = { [blobHash]: { copyCount: 1, occurrences: [occurrence] } };
  const instructions = { [instructionsHash]: [blobHash] };
  for (let i = 0; i < 256; i++) {
    const prefix = i.toString(16).padStart(2, "0");
    await writeGzip(
      path.join(target, "index", "exact", prefix + ".json.gz"),
      prefix === blobHash.slice(0, 2) ? exact : {}
    );
    await writeGzip(
      path.join(target, "index", "instructions", prefix + ".json.gz"),
      prefix === instructionsHash.slice(0, 2) ? instructions : {}
    );
    await writeGzip(path.join(target, "index", "variants", "anchors", prefix + ".json.gz"), {});
  }
  console.log("Synthetic SkillLineage demo created at " + target);
  console.log("Use the indexed Skill for an exact match and metadata-edit for same_instructions.");
  console.log("This fixture has no stored history and is NOT the GitSkills global dataset.");
} catch (error) {
  await rm(target, { recursive: true, force: true });
  throw error;
}
