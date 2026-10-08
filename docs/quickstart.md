# SkillLineage v1.0.0 — Five-minute first run

This walkthrough exercises the **published npm package** against a small,
**entirely synthetic**, schema-0.5 index. It does not download GitSkills,
depend on Python, or make any historical-origin claims.

## Requirements

- Node.js 22 or newer, npm, and Git.
- Network access to npm for the first package installation.
- No account, API key, database, or real Skill text.

## Quickstart (macOS, Linux, and Windows PowerShell)

Clone the source repository to obtain the offline demo fixture generator:

```bash
git clone https://github.com/mehdimt1980/skilllineage.git
cd skilllineage

# The destination must not already exist. The script never overwrites it.
node tools/create-demo-fixture.mjs .skilllineage-demo

# Execute exactly the publicly published v1.0.0 package.
npx --yes skilllineage@1.0.0 --version
npx --yes skilllineage@1.0.0 fingerprint .skilllineage-demo/skills/indexed
npx --yes skilllineage@1.0.0 compare .skilllineage-demo/skills/indexed .skilllineage-demo/skills/metadata-edit
npx --yes skilllineage@1.0.0 trace .skilllineage-demo/skills/indexed --index .skilllineage-demo/index
npx --yes skilllineage@1.0.0 trace .skilllineage-demo/skills/metadata-edit --index .skilllineage-demo/index
```

The command output is JSON. Check these fields:

| Command | Expected evidence |
| --- | --- |
| `--version` | `1.0.0` |
| `fingerprint` | `schemaVersion: "0.1"` and deterministic fingerprints |
| `compare` | `relation: "same_instructions"` and `similarity.instructions: 1` |
| `trace` on `indexed` | `match.type: "exact"`, `match.copyCount: 1` |
| `trace` on `metadata-edit` | `match.type: "same_instructions"`, `match.copyCount: 1` |

Both trace outputs must report:

```json
{
  "origin": {
    "status": "not_inferred"
  }
}
```

The example has **no historical data**: `history.status: "not_available"`
is intentional. No timestamp or attribution is invented. The occurrence
`synthetic-example/onboarding` is a fictional fixture label, not a real repository.

## How this works

The generator creates two different raw `SKILL.md` files with identical
normalized instructions, a tiny manifest and compressed lookup shards.
All other exact/instruction/anchor shard routes are empty. It deliberately
does not include a sketch-based variant index or GitSkills content.

It creates roughly 768 small gzip shard files because the schema-0.5
reader expects the fixed 256-prefix exact, instruction and anchor spaces.
The index files are output artifacts, not part of the published npm tarball.

To try a different directory, provide a new path to
`node tools/create-demo-fixture.mjs <new-output-directory>`.
The generator refuses to overwrite existing directories.

## After the first run

For real-data global tracing, prepare a **separate** index from GitSkills
with the offline Python builder in this repository. It requires a preexisting
GitSkills SQLite database and a compatible schema-0.5 index:

```bash
python tools/build-gitskills-index.py /path/to/gitskills.db ./gitskills-index
npx --yes skilllineage@1.0.0 trace ./my-skill --index ./gitskills-index
```

The npm package does **not** include GitSkills data, the offline builder,
or a downloadable global index. Consult the main [README](../README.md)
for dataset attribution and setup limitations.

Remember: exact matches, instruction similarities and dataset observation
orders are **evidence, not proof of original authorship, plagiarism,
ancestry or the direction of copying**.

## For contributors

The repository also runs a cross-platform smoke test against the immutable
public package version:

```bash
node tools/test-published-package.mjs
```

This test creates and removes its own temporary consumer and synthetic
fixture directories. It never imports the local `dist/` build.
