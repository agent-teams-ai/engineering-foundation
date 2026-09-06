#!/usr/bin/env node

import { runDocsCli } from "./features/docs-command/index.js";

process.exitCode = await runDocsCli(process.argv.slice(2));
