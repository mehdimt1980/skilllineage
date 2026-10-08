#!/usr/bin/env node
// An opt-in local real-data pipeline. Does not fetch, upload, publish or mutate datasets.
// Requires a separately obtained SQLite dataset and a previously built schema-0.5 index.
import { access, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { throw new Error(message); }
function isWithin(parent, target) {
  const rel = path.relative(parent, target);
  return !rel || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}
async function exists(p) {
  try { await access(p); return true; } catch (e) { if (e?.code === "ENOENT") return false; throw e; }
}
async function command(cmd, args, cwd = root) {
  console.log("Running: " + path.basename(cmd) + " " + args.map(x=>x.includes(" ") ? JSON.stringify(x) : x).join(" "));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (c, signal) => {
      if (signal) reject(new Error("Command terminated by signal: " + signal));
      else resolve(c);
    });
  });
  if (code !== 0) fail(path.basename(cmd) + " failed with exit code " + code);
}
function argsFrom(argv) {
  const opts = { samples: 30, seed: 42 };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!["--db", "--index", "--integrity", "--out", "--samples", "--seed"].includes(key))
      fail("Unknown option: " + key);
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) fail("Missing value for " + key);
    const prop = key.slice(2);
    if (seen.has(prop)) fail("Duplicate option: " + key);
    seen.add(prop);
    opts[prop] = argv[++i];
  }
  for (const p of ["db", "index", "integrity", "out"]) if(!opts[p]) fail("Missing --" + p);
  for (const p of ["samples", "seed"]) {
    const n=Number(opts[p]);
    if (!Number.isSafeInteger(n) || n < (p==="samples" ? 1 : 0) || (p==="samples" && n > 10000))
      fail("Invalid --" + p);
    opts[p]=n;
  }
  return opts;
}
const usage = "Usage: node tools/run-realdata-validation.mjs --db <source.db> --index <schema-0.5-index> --integrity <sidecar.json> --out <NEW external report directory> [--samples 30] [--seed 42]";
try {
  const opts = argsFrom(process.argv.slice(2));
  const db = path.resolve(opts.db);
  const index = path.resolve(opts.index);
  const sidecar = path.resolve(opts.integrity);
  const out = path.resolve(opts.out);
  if (isWithin(root, out)) fail("Output must be outside repository to prevent leaking sample identifiers");
  if (isWithin(index, out) || isWithin(out, index) || isWithin(out, db) || isWithin(out, sidecar))
    fail("Output overlaps source/input paths");
  if (await exists(out)) fail("Output already exists; refusing to overwrite: " + out);
  if (!(await exists(db)) || !(await exists(index)) || !(await exists(sidecar)))
    fail("Missing source SQLite, index or integrity sidecar");

  // Inspect and verify first, before any benchmark or output generation.
  await command(process.env.SKILLLINEAGE_PYTHON || "python", ["tools/check-gitskills-source.py", db]);
  await command(process.execPath, ["tools/index-integrity.mjs", "verify", index, sidecar]);
  if (process.platform === "win32") {
    // Execute the trusted constant command via cmd.exe; do not pass user paths to it.
    await command(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build"]);
  } else await command("npm", ["run", "build"]);

  await mkdir(out); // exclusive, after preflight
  console.log("Raw benchmark may contain repository/path identifiers; keep " + out + " PRIVATE.");
  const raw = path.join(out, "raw-benchmark.json");
  const aggregate = path.join(out, "aggregate-only.json");
  await command(process.env.SKILLLINEAGE_PYTHON || "python", [
    "tools/benchmark-gitskills.py",
    "--db", db, "--index", index, "--samples", String(opts.samples),
    "--seed", String(opts.seed), "--output", raw
  ]);
  await command(process.execPath, ["tools/benchmark-summary.mjs", raw, aggregate]);
  console.log("PASS: real-data validation generated private raw report and shareable aggregate.");
  console.log("Human review is required before publishing even the aggregate.");
} catch (error) {
  console.error("ERROR: " + error.message);
  console.error("If a newly created report directory exists, it may contain partial PRIVATE data; review before deleting.");
  console.error(usage);
  process.exitCode = 1;
}
