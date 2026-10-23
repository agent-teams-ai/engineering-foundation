#!/usr/bin/env node
import { main } from "./features/toolchain-execution/adapters/run-cli.js";

process.exitCode = await main(process.argv.slice(2));
