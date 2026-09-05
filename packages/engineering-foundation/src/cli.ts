#!/usr/bin/env node

import { runNodeFoundationCli } from "./composition/command-host.js";

await runNodeFoundationCli(process.env, import.meta.url, process.argv.slice(2));
