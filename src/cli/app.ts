import { createRequire } from "node:module";
import { fingerprint, FingerprintError } from "../fingerprint/index.js";
import { compareSkills } from "../compare/index.js";
import { traceSkill, TraceError } from "../trace/index.js";
import { IndexError } from "../index/index.js";

interface PackageJson {
  version: string;
}

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as PackageJson;

export const VERSION = pkg.version;

const HELP = `
skilllineage v${VERSION}

Trace copies, variants, and lineage evidence of AI Agent Skills.

USAGE
  skilllineage [options] <command> [args]

COMMANDS
  fingerprint <path>              Generate a deterministic fingerprint report
  compare <skill-a> <skill-b>     Compare two local skills
  trace <path> --index <dir>      Trace a skill against a GitSkills index

OPTIONS
  -h, --help                      Show this help message
  -v, --version                   Show version number

EXAMPLES
  skilllineage fingerprint .
  skilllineage compare ./original ./fork
  skilllineage trace ./my-skill --index ./gitskills-index
`.trimStart();

export interface CliResult {
  stdout: string;
  exitCode: number;
}

export function run(argv: readonly string[]): CliResult | Promise<CliResult> {
  if (argv.includes("--version") || argv.includes("-v")) {
    return { stdout: VERSION, exitCode: 0 };
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    return { stdout: HELP, exitCode: 0 };
  }

  const command = argv[0];

  if (command === "fingerprint") {
    const target = argv[1];
    if (!target) {
      return {
        stdout: "Error: fingerprint requires a <path> argument.",
        exitCode: 1,
      };
    }
    return runFingerprint(target);
  }

  if (command === "compare") {
    const pathA = argv[1];
    const pathB = argv[2];
    if (!pathA || !pathB) {
      return {
        stdout:
          "Error: compare requires two arguments: <skill-a> <skill-b>.",
        exitCode: 1,
      };
    }
    return runCompare(pathA, pathB);
  }

  if (command === "trace") {
    const skillPath = argv[1];
    if (!skillPath) {
      return {
        stdout: "Error: trace requires a <path> argument.",
        exitCode: 1,
      };
    }
    const indexIdx = argv.indexOf("--index");
    const indexDir = indexIdx !== -1 ? argv[indexIdx + 1] : undefined;
    if (!indexDir) {
      return {
        stdout: "Error: trace requires --index <dir>.",
        exitCode: 1,
      };
    }
    return runTrace(skillPath, indexDir);
  }

  // No command or unknown command: show help
  return { stdout: HELP, exitCode: 0 };
}

async function runFingerprint(target: string): Promise<CliResult> {
  try {
    const report = await fingerprint(target, VERSION);
    return {
      stdout: JSON.stringify(report, null, 2),
      exitCode: 0,
    };
  } catch (error) {
    if (error instanceof FingerprintError) {
      return { stdout: `Error: ${error.message}`, exitCode: 1 };
    }
    throw error;
  }
}

async function runCompare(pathA: string, pathB: string): Promise<CliResult> {
  try {
    const report = await compareSkills(pathA, pathB, VERSION);
    return {
      stdout: JSON.stringify(report, null, 2),
      exitCode: 0,
    };
  } catch (error) {
    if (error instanceof FingerprintError) {
      return { stdout: `Error: ${error.message}`, exitCode: 1 };
    }
    throw error;
  }
}

async function runTrace(
  skillPath: string,
  indexDir: string,
): Promise<CliResult> {
  try {
    const report = await traceSkill(skillPath, indexDir, VERSION);
    return {
      stdout: JSON.stringify(report, null, 2),
      exitCode: 0,
    };
  } catch (error) {
    if (
      error instanceof FingerprintError ||
      error instanceof IndexError ||
      error instanceof TraceError
    ) {
      return { stdout: `Error: ${error.message}`, exitCode: 1 };
    }
    throw error;
  }
}
