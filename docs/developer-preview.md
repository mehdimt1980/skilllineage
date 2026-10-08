# SkillLineage v1.0.0 — Developer Preview / first-user handoff

**Status:** public npm release, open-source CLI, **local-first**. You can test \`fingerprint\` and \`compare\` immediately. \`trace\` requires a separately supplied, compatible **local** schema-0.5 index. There is **no hosted/global index lookup included**.

## 1. Start from the published npm package

Requirements: Node.js 22+ and npm. No SaaS account or API key.

\`\`\`sh
npx --yes skilllineage@1.0.0 --version
npx --yes skilllineage@1.0.0 --help
\`\`\`

For **your own skills**, use two local folders each containing a \`SKILL.md\`:

\`\`\`sh
npx --yes skilllineage@1.0.0 fingerprint ./my-skill
npx --yes skilllineage@1.0.0 compare ./my-skill ./another-skill
\`\`\`

The results are deterministic **for the supplied input and current tool version**, but they are not plagiarism verdicts. Do not upload private skills to public issues or online pastebins. The CLI works locally after the initial npm installation.

## 2. Repeat a fully reproducible, synthetic trace demo

Clone the source repo to get the fixture generator (not bundled in npm):

\`\`\`sh
git clone https://github.com/mehdimt1980/skilllineage.git
cd skilllineage
node tools/create-demo-fixture.mjs .skilllineage-demo

npx --yes skilllineage@1.0.0 fingerprint .skilllineage-demo/skills/indexed
npx --yes skilllineage@1.0.0 compare .skilllineage-demo/skills/indexed .skilllineage-demo/skills/metadata-edit
npx --yes skilllineage@1.0.0 trace .skilllineage-demo/skills/indexed --index .skilllineage-demo/index
npx --yes skilllineage@1.0.0 trace .skilllineage-demo/skills/metadata-edit --index .skilllineage-demo/index
\`\`\`

See the [five-minute quickstart](quickstart.md) for expected JSON and [index accessibility](index-accessibility.md) for local indexing of a separately obtained GitSkills sample.

**Important limits:** A local \`match.type: "none"\` is relative to the **supplied local index snapshot**, not a universal negative. GitSkills observations and similarity scores do not prove origin, copying direction or wrongdoing. The npm package does not silently upload skill content.

## 3. Optional maintainer-only PR #21 adapter exercise

The source repository contains a **synthetic-only**, opt-in, loopback-only example demonstrating partial-data handling:

\`\`\`sh
node tools/test-compact-manifest-session.mjs
node tools/test-synthetic-reader-adapter.mjs
\`\`\`

\`tools/synthetic-reader-adapter.mjs\` checks the exact and normalized-instructions tiers using verified shard bytes. It can return \`verified_positive\` for **those tiers only**. If they are absent, it returns \`indeterminate\` because variant matching and history have **not** been evaluated. It is **not** wired into \`npx skilllineage@1.0.0 trace\` and is not a production remote query service.

## 4. What kind of feedback helps?

Please test the CLI on a non-sensitive, permissively licensed example and [open a GitHub issue](https://github.com/mehdimt1980/skilllineage/issues) with:

- OS, Node version, SkillLineage version; whether you installed through \`npx\`.
- Command tried (redact personal paths, tokens, repository IDs and private skill content).
- Expected result and observed result, or exact error message with secrets redacted.
- Whether you used no index, synthetic demo index, sample GitSkills index or another **local** index.
- Optional: Was onboarding intuitive? Did the output communicate its evidence and limitations clearly?

Report errors, misleading output and usability problems. Do not share third-party index files, raw GitSkills data or unreleased private SKILL.md content in public tickets.

## 5. Release promise and next iteration

This developer preview is intentionally **not** advertised as a fully hosted global trace service. Improvements should be driven by independent user feedback on installation, CLI output and local-index UX. Any future production index distribution requires separate licensing/privacy, authenticity, revocation/takedown and completeness audits. The release itself remains \`1.0.0\` until a separately gated, appropriately versioned publish occurs.
