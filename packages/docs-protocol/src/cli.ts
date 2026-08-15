#!/usr/bin/env node

import { runDocsCli } from "./composition/cli.js";

process.exitCode = await runDocsCli(process.argv.slice(2));
