#!/usr/bin/env node

import { run } from "./app.js";

const result = await run(process.argv.slice(2));
process.stdout.write(result.stdout + "\n");
process.exit(result.exitCode);
