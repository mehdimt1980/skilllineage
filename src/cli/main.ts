#!/usr/bin/env node

import { run } from "./app.js";

const result = await run(process.argv.slice(2));
if (result.stdout) {
  process.stdout.write(result.stdout + "\n");
}
if (result.stderr) {
  process.stderr.write(result.stderr + "\n");
}
// Set the code without forcing an immediate exit so piped JSON/error output can flush completely.
process.exitCode = result.exitCode;
