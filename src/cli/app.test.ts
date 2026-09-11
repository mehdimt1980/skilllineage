import { describe, it, expect } from "vitest";
import { run, VERSION } from "./app.js";

describe("CLI", () => {
  it("returns version with --version", () => {
    const result = run(["--version"]);
    expect(result).toEqual({ stdout: VERSION, exitCode: 0 });
  });

  it("returns version with -v", () => {
    const result = run(["-v"]);
    expect(result).toEqual({ stdout: VERSION, exitCode: 0 });
  });

  it("returns help with --help", () => {
    const result = run(["--help"]) as { stdout: string; exitCode: number };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USAGE");
    expect(result.stdout).toContain("skilllineage");
  });

  it("returns help with -h", () => {
    const result = run(["-h"]) as { stdout: string; exitCode: number };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USAGE");
  });

  it("returns help when called with no args", () => {
    const result = run([]) as { stdout: string; exitCode: number };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USAGE");
  });

  it("returns error when fingerprint called without path", () => {
    const result = run(["fingerprint"]) as {
      stdout: string;
      exitCode: number;
    };
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("requires a <path> argument");
  });

  it("returns error when compare called without paths", () => {
    const result = run(["compare"]) as {
      stdout: string;
      exitCode: number;
    };
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("requires two arguments");
  });

  it("returns error when compare called with only one path", () => {
    const result = run(["compare", "./a"]) as {
      stdout: string;
      exitCode: number;
    };
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("requires two arguments");
  });

  it("returns error when trace called without path", () => {
    const result = run(["trace"]) as {
      stdout: string;
      exitCode: number;
    };
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("requires a <path> argument");
  });

  it("returns error when trace called without --index", () => {
    const result = run(["trace", "./skill"]) as {
      stdout: string;
      exitCode: number;
    };
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("requires --index");
  });

  it("version matches semver pattern", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
