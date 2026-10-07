import { describe, it, expect } from "vitest";
import { run, VERSION } from "./app.js";

describe("CLI", () => {
  it("returns version with --version", async () => {
    const result = await run(["--version"]);
    expect(result).toEqual({ stdout: VERSION, stderr: "", exitCode: 0 });
  });

  it("returns version with -v", async () => {
    const result = await run(["-v"]);
    expect(result).toEqual({ stdout: VERSION, stderr: "", exitCode: 0 });
  });

  it("returns help with --help", async () => {
    const result = await run(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USAGE");
    expect(result.stdout).toContain("skilllineage");
    expect(result.stderr).toBe("");
  });

  it("returns help with -h", async () => {
    const result = await run(["-h"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USAGE");
    expect(result.stderr).toBe("");
  });

  it("returns help when called with no args", async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USAGE");
    expect(result.stderr).toBe("");
  });

  it("returns error on stderr when unknown command is passed", async () => {
    const result = await run(["nonsense"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('Unknown command "nonsense"');
  });

  it("returns error when fingerprint called without path", async () => {
    const result = await run(["fingerprint"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires a <path> argument");
  });

  it("returns error when compare called without paths", async () => {
    const result = await run(["compare"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires two arguments");
  });

  it("returns error when compare called with only one path", async () => {
    const result = await run(["compare", "./a"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires two arguments");
  });

  it("returns error when trace called without path", async () => {
    const result = await run(["trace"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires a <path> argument");
  });

  it("returns error when trace called without --index", async () => {
    const result = await run(["trace", "./skill"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires --index");
  });

  it("version matches semver pattern", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
