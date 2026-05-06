#!/usr/bin/env node
import { createProgram } from './cli-program.js';

createProgram().parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
