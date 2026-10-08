#!/usr/bin/env node
// All cases use the existing wholly synthetic Phase-14A fixture; no GitSkills download.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const integrity = path.join(root, "tools", "index-integrity.mjs");
const fixture = path.join(root, "tools", "create-demo-fixture.mjs");
const tmp = await mkdtemp(path.join(tmpdir(), "skilllineage-index-integrity-"));
async function exec(...args) {
  return run(process.execPath, [integrity, ...args], { cwd: root, timeout: 120000 });
}
async function fails(args, pattern) {
  let failed = false;
  try {
    await exec(...args);
  } catch (error) {
    failed = true;
    assert.notEqual(error.code, 0);
    assert.match(error.stderr, new RegExp(pattern, "i"));
  }
  assert(failed, "Expected failure for " + args.join(" "));
}
try {
  const demo = path.join(tmp, "demo");
  const index = path.join(demo, "index");
  const sidecar = path.join(tmp, "index-integrity.json");
  const copy = path.join(tmp, "index-integrity-copy.json");
  await run(process.execPath, [fixture, demo], { cwd: root, timeout: 120000 });
  await exec("generate", index, sidecar);
  await exec("generate", index, copy);
  assert.equal(await readFile(sidecar, "utf8"), await readFile(copy, "utf8"));
  const snapshot = JSON.parse(await readFile(sidecar, "utf8"));
  assert.equal(snapshot.format, "skilllineage-index-integrity-1");
  assert.equal(snapshot.indexSchemaVersion, "0.5");
  assert.equal(snapshot.fileCount, 769);
  await exec("verify", index, sidecar);
  await fails(["generate", index, sidecar], "EEXIST");
  await fails(["generate", index, path.join(index, "sidecar.json")], "outside");
  await fails(["verify", index, path.join(index, "sidecar.json")], "outside");

  const victim = path.join(index, "exact", "00.json.gz");
  const original = await readFile(victim);
  await writeFile(victim, Buffer.concat([original, Buffer.from("tampered")]));
  await fails(["verify", index, sidecar], "mismatch");
  await writeFile(victim, original);
  await writeFile(path.join(index, "extra.json"), "unexpected");
  await fails(["verify", index, sidecar], "count mismatch");
  await rm(path.join(index, "extra.json"));
  const edited = JSON.parse(await readFile(sidecar, "utf8"));
  edited.files[0].path = "../unsafe.txt";
  const bad = path.join(tmp, "bad.json");
  await writeFile(bad, JSON.stringify(edited));
  await fails(["verify", index, bad], "malformed|untrusted");

  const link = path.join(index, "untrusted-link");
  let madeLink = false;
  try { await symlink(victim, link); madeLink = true; }
  catch (err) { if (!["EPERM", "EACCES", "ENOTSUP"].includes(err?.code)) throw err; }
  if (madeLink) {
    await fails(["verify", index, sidecar], "symlink");
    await rm(link);
  }
  console.log("PASS: deterministic manifest, byte verification, overwrite denial, tamper, extra-file, unsafe path, symlink guards");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
