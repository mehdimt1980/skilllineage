#!/usr/bin/env node
// Fail closed if any schema-0.5 TypeScript index field lacks an explicit
// field-level data-exposure risk label in the reviewed audit inventory.
// This is a contract coverage test, not a legal audit or PII/content scanner.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventory = JSON.parse(await readFile(path.join(root, "docs/index-field-inventory.json"), "utf8"));
const source = await readFile(path.join(root, "src/index/types.ts"), "utf8");
const builder = await readFile(path.join(root, "tools/build-gitskills-index.py"), "utf8");

assert.equal(inventory.format, "skilllineage-index-field-inventory-1");
assert.equal(inventory.indexSchemaVersion, "0.5");
assert.equal(inventory.publicRedistribution, "BLOCKED_PENDING_REVIEW");
assert.equal(inventory.reviewStatus, "technical_inventory_only");
const validRisks = new Set(["low", "moderate", "high"]);
const parsed = ts.createSourceFile("types.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const actual = {};
for (const node of parsed.statements) {
  if (!ts.isInterfaceDeclaration(node)) continue;
  if (!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
  const fields = node.members.map(member => {
    assert(ts.isPropertySignature(member), "Unexpected non-property member in " + node.name.text);
    const field = member.name;
    assert(ts.isIdentifier(field) || ts.isStringLiteral(field), "Unexpected computed member");
    return field.text;
  }).sort();
  actual[node.name.text] = fields;
}
assert.deepEqual(Object.keys(inventory.interfaces).sort(), Object.keys(actual).sort(),
  "New/removed TypeScript interface requires an explicit distribution risk review");
let reviewedFields = 0;
let high = 0;
for (const [name, fields] of Object.entries(inventory.interfaces)) {
  assert.deepEqual(Object.keys(fields).sort(), actual[name],
    "Index type fields changed without audit inventory update: " + name);
  for (const risk of Object.values(fields)) {
    assert(validRisks.has(risk), "Missing or invalid risk label in " + name);
    reviewedFields++;
    if (risk === "high") high++;
  }
}
const routes = inventory.namespaces.map(x => x.directory);
assert.deepEqual(routes, [
 "manifest.json",
 "exact/*.json.gz",
 "instructions/*.json.gz",
 "variants/anchors/*.json.gz",
 "variants/sketches/*/*.json.gz",
 "variants/enrichment/*/*.json.gz",
 "history/exact/*/*.json.gz",
 "history/instructions/*/*.json.gz"
], "Physical index namespace inventory changed without review");
for (const entry of inventory.namespaces) {
  assert(typeof entry.entry === "string" && entry.entry.length);
  assert(typeof entry.dynamicKey === "string" && entry.dynamicKey.length);
  assert(typeof entry.exposure === "string" && entry.exposure.length);
}
// Positive checks for high-risk emitter contracts: missing one should trigger
// a manual re-review, even if the TS reader type was not updated.
for (const token of [
 '"repoFullName"', '"path"', '"stars"', '"historyFetched"',
 '"instructionsSha256"', '"sketch"', '"examples"', '"earliestObserved"',
 '"latestObserved"', '"firstCommitAt"', '"lastCommitAt"', '"copyCount"'
]) {
  assert(builder.includes(token), "Builder field emitter changed: " + token);
}
assert(inventory.blockers.length >= 4, "Blocking review gates must remain explicit");
assert(inventory.nonGoals.some(x => x.includes("legal")));
console.log("PASS: " + Object.keys(actual).length + " index interfaces / " +
  reviewedFields + " classified fields / " + high + " high-risk fields / " +
  routes.length + " on-disk namespaces.");
console.log("PUBLIC REDISTRIBUTION IS BLOCKED; coverage test does not establish legal permission or privacy safety.");
