#!/usr/bin/env node

import { runManagedDocsCli } from "./composition/managed-cli.js";

process.exitCode = await runManagedDocsCli(process.argv.slice(2));
