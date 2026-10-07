#!/usr/bin/env node

import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tscBin = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
const rootPackage = JSON.parse(
  await readFile(path.join(rootDir, "package.json"), "utf-8"),
);
const expectedVersion = rootPackage.version;

async function runCommand(cmd, args, options = {}) {
  const isWindows = process.platform === "win32";
  const executable =
    isWindows && (cmd === "npm" || cmd === "npx") ? `${cmd}.cmd` : cmd;
  return execFileAsync(executable, args, {
    cwd: rootDir,
    shell: isWindows,
    ...options,
  });
}

const tempDir = await mkdtemp(path.join(tmpdir(), "skilllineage-smoke-"));

try {
  console.log("1. Building clean production bundle...");
  await runCommand("npm", ["run", "build"]);

  console.log("2. Packing npm tarball into temporary directory...");
  const packResult = await runCommand("npm", [
    "pack",
    "--json",
    "--pack-destination",
    tempDir,
  ]);
  const packInfo = JSON.parse(packResult.stdout);
  assert(Array.isArray(packInfo) && packInfo.length > 0, "npm pack output should be an array");
  const pkg = packInfo[0];
  assert.strictEqual(pkg.name, rootPackage.name, "Packed package name mismatch");
  assert.strictEqual(pkg.version, expectedVersion, "Packed package version mismatch");

  const tarballFilename = pkg.filename;
  const tarballPath = path.join(tempDir, tarballFilename);

  console.log(
    `   Created tarball: ${tarballFilename} (${pkg.size} bytes packed, ${pkg.unpackedSize} bytes unpacked)`,
  );

  console.log("3. Asserting tarball content allowlist & denylist...");
  const files = (pkg.files || []).map((file) =>
    (typeof file === "string" ? file : file.path).replace(/^package\//, ""),
  );
  assert(files.length > 0, "Tarball must contain files");

  const requiredFiles = [
    "package.json",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/cli/main.js",
    "README.md",
    "README.de.md",
    "LICENSE",
    "CHANGELOG.md",
  ];

  for (const required of requiredFiles) {
    assert(
      files.includes(required),
      `Required file missing from npm tarball: ${required}. Found: ${JSON.stringify(files)}`,
    );
  }

  const forbiddenPatterns = [
    /^src\//,
    /^tools\//,
    /^\.github\//,
    /\.test\./,
    /\.spec\./,
    /__tests__/,
    /benchmark.*\.json/i,
    /\.db$/i,
    /\.sqlite$/i,
    /history.*audit/i,
    /^\.env(?:\.|$)/i,
    /full-index/i,
    /^phase11.*\.py$/i,
    /__pycache__/i,
    /\.py[co]$/i,
  ];

  for (const file of files) {
    for (const pattern of forbiddenPatterns) {
      assert(
        !pattern.test(file),
        `Forbidden file found in npm tarball: ${file} (matched ${pattern})`,
      );
    }
  }

  assert(
    !Object.keys(rootPackage).some((key) =>
      ["dependencies", "optionalDependencies", "peerDependencies"].includes(key) &&
      rootPackage[key] &&
      Object.keys(rootPackage[key]).length > 0
    ),
    "SkillLineage must keep zero runtime/optional/peer dependencies",
  );

  console.log("4. Verifying built CLI binary hashbang...");
  const builtMainJs = await readFile(
    path.join(rootDir, "dist", "cli", "main.js"),
    "utf-8",
  );
  assert(
    builtMainJs.startsWith("#!/usr/bin/env node"),
    "dist/cli/main.js must start with #!/usr/bin/env node",
  );

  console.log("5. Creating isolated consumer project...");
  const consumerDir = path.join(tempDir, "consumer");
  await mkdir(consumerDir, { recursive: true });

  await writeFile(
    path.join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name: "consumer-smoke-test",
        version: "1.0.0",
        type: "module",
        private: true,
      },
      null,
      2,
    ),
    "utf-8",
  );

  console.log("6. Installing generated tarball into consumer project...");
  await runCommand(
    "npm",
    ["install", tarballPath, "--no-audit", "--no-fund", "--ignore-scripts"],
    { cwd: consumerDir },
  );

  const installedPackagePath = path.join(
    consumerDir,
    "node_modules",
    "skilllineage",
    "package.json",
  );
  const installedPackage = JSON.parse(
    await readFile(installedPackagePath, "utf-8"),
  );
  assert.strictEqual(installedPackage.version, expectedVersion);
  assert.deepStrictEqual(installedPackage.bin, {
    skilllineage: "./dist/cli/main.js",
  });

  const installedMainPath = path.join(
    consumerDir,
    "node_modules",
    "skilllineage",
    "dist",
    "cli",
    "main.js",
  );
  const installedMain = await readFile(installedMainPath, "utf-8");
  assert(
    installedMain.startsWith("#!/usr/bin/env node"),
    "Installed CLI target must retain the node hashbang",
  );

  console.log("7. Testing runtime programmatic imports from installed package...");
  const testScript = `
import { VERSION, fingerprint, compareSkills, traceSkill } from "skilllineage";
import assert from "node:assert";

assert.strictEqual(typeof fingerprint, "function", "fingerprint must be a function");
assert.strictEqual(typeof compareSkills, "function", "compareSkills must be a function");
assert.strictEqual(typeof traceSkill, "function", "traceSkill must be a function");
assert.strictEqual(VERSION, ${JSON.stringify(expectedVersion)}, "VERSION must match installed package version");
console.log("Runtime imports OK! VERSION=" + VERSION);
`;
  await writeFile(path.join(consumerDir, "smoke.js"), testScript, "utf-8");
  const smokeResult = await runCommand("node", ["smoke.js"], { cwd: consumerDir });
  assert(smokeResult.stdout.includes("Runtime imports OK!"), "Runtime import smoke test failed");

  console.log("8. Testing installed CLI wrapper execution...");
  const cliWrapper = path.join(
    consumerDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "skilllineage.cmd" : "skilllineage",
  );

  const versionRes = await runCommand(cliWrapper, ["--version"], {
    cwd: consumerDir,
  });
  assert.strictEqual(
    versionRes.stdout.trim(),
    expectedVersion,
    "CLI --version output mismatch",
  );
  assert.strictEqual(versionRes.stderr.trim(), "", "CLI --version should have empty stderr");

  const helpRes = await runCommand(cliWrapper, ["--help"], { cwd: consumerDir });
  assert(helpRes.stdout.includes("USAGE"), "CLI --help should contain USAGE");
  assert(helpRes.stdout.includes("fingerprint"), "CLI --help should contain fingerprint");
  assert(helpRes.stdout.includes("compare"), "CLI --help should contain compare");
  assert(helpRes.stdout.includes("trace"), "CLI --help should contain trace");
  assert.strictEqual(helpRes.stderr.trim(), "", "CLI --help should have empty stderr");

  try {
    await runCommand(cliWrapper, ["nonsense"], { cwd: consumerDir });
    assert.fail("Unknown command should exit with non-zero code");
  } catch (error) {
    assert(error.code !== 0, "Unknown command must fail with non-zero exit code");
    assert(
      error.stderr.includes("Unknown command") || error.stderr.includes("nonsense"),
      `Expected stderr error message, got: ${error.stderr}`,
    );
    assert.strictEqual(error.stdout.trim(), "", "Unknown command should not write stdout");
  }

  console.log("9. Testing TypeScript consumer type resolution...");
  const tsConsumerCode = `
import {
  VERSION,
  fingerprint,
  compareSkills,
  traceSkill,
  type FingerprintReport,
  type CompareReport,
  type TraceReport,
  type TraceEvidenceSummary,
} from "skilllineage";

const v: string = VERSION;
const f: typeof fingerprint = fingerprint;
const c: typeof compareSkills = compareSkills;
const t: typeof traceSkill = traceSkill;

export type { FingerprintReport, CompareReport, TraceReport, TraceEvidenceSummary };
`;
  await writeFile(path.join(consumerDir, "consumer.ts"), tsConsumerCode, "utf-8");
  await writeFile(
    path.join(consumerDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    ),
    "utf-8",
  );

  await runCommand("node", [tscBin, "-p", "tsconfig.json"], {
    cwd: consumerDir,
  });

  console.log("Package smoke test passed successfully!");
} finally {
  console.log("Cleaning temporary directory...");
  await rm(tempDir, { recursive: true, force: true });
}
