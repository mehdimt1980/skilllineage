#!/usr/bin/env node
// Public-registry consumer smoke: never imports the local dist/ build.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "1.0.0"; // Immutable released version under test, not the working-tree version.
const SPEC = "skilllineage@" + VERSION;
const win = process.platform === "win32";

async function execute(command, args, cwd) {
  const cmd = win && command === "npm" ? "npm.cmd" : command;
  return execFileAsync(cmd, args, {
    cwd,
    shell: win,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024
  });
}

const temporary = await mkdtemp(path.join(tmpdir(), "skilllineage-public-"));
const consumer = path.join(temporary, "consumer");
const demo = path.join(temporary, "demo");

try {
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"),
    JSON.stringify({ name: "skilllineage-public-consumer", version: "1.0.0", private: true, type: "module" }));

  console.log("Installing exact published npm version " + SPEC + " in a clean consumer directory...");
  await execute("npm", [
    "install", "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-online",
    "--registry=https://registry.npmjs.org/", "--save-exact", SPEC
  ], consumer);

  const installed = JSON.parse(await readFile(
    path.join(consumer, "node_modules", "skilllineage", "package.json"), "utf8"
  ));
  assert.equal(installed.name, "skilllineage");
  assert.equal(installed.version, VERSION);
  assert.equal(Object.keys(installed.dependencies ?? {}).length, 0);

  console.log("Creating synthetic schema-0.5 first-user fixture...");
  await execute(process.execPath, [path.join(root, "tools", "create-demo-fixture.mjs"), demo], root);
  const indexed = path.join(demo, "skills", "indexed");
  const metadataEdit = path.join(demo, "skills", "metadata-edit");
  const index = path.join(demo, "index");

  // Exercise the consumer's actual executable wrapper, including Windows .cmd.
  const cli = path.join(
    consumer, "node_modules", ".bin", win ? "skilllineage.cmd" : "skilllineage"
  );
  async function cliJson(args) {
    const result = await execute(cli, args, consumer);
    assert.equal(result.stderr.trim(), "", "Valid CLI commands must not emit stderr");
    return JSON.parse(result.stdout);
  }
  const versionResult = await execute(cli, ["--version"], consumer);
  assert.equal(versionResult.stdout.trim(), VERSION);
  const helpResult = await execute(cli, ["--help"], consumer);
  assert.match(helpResult.stdout, /trace/);

  const fp = await cliJson(["fingerprint", indexed]);
  assert.equal(fp.schemaVersion, "0.1");
  assert.equal(fp.tool.version, VERSION);

  const comparison = await cliJson(["compare", indexed, metadataEdit]);
  assert.equal(comparison.relation, "same_instructions");
  assert.equal(comparison.similarity.instructions, 1);

  const exact = await cliJson(["trace", indexed, "--index", index]);
  assert.equal(exact.schemaVersion, "0.5");
  assert.equal(exact.match.type, "exact");
  assert.equal(exact.match.copyCount, 1);
  assert.deepEqual(exact.origin, { status: "not_inferred" });

  const same = await cliJson(["trace", metadataEdit, "--index", index]);
  assert.equal(same.match.type, "same_instructions");
  assert.equal(same.match.copyCount, 1);
  assert.deepEqual(same.origin, { status: "not_inferred" });
  assert.equal(same.match.history.status, "not_available");

  // Node ESM import must resolve from installed npm bytes, not repository source.
  const apiScript = [
    'import assert from "node:assert/strict";',
    'import { VERSION, fingerprint, compareSkills, traceSkill } from "skilllineage";',
    'assert.equal(VERSION, "1.0.0");',
    'assert.equal(typeof fingerprint, "function");',
    'assert.equal(typeof compareSkills, "function");',
    'assert.equal(typeof traceSkill, "function");',
    'console.log("Public ESM API imports OK");'
  ].join("\n");
  await writeFile(path.join(consumer, "api.mjs"), apiScript);
  const api = await execute(process.execPath, ["api.mjs"], consumer);
  assert.match(api.stdout, /Public ESM API imports OK/);

  console.log("PASS: public npm " + SPEC + " CLI, ESM, synthetic exact and same_instructions on " + process.platform);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
