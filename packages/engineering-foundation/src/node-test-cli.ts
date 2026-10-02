#!/usr/bin/env node

import { runProcessMandatoryNodeTests } from "./capabilities/quality-gate-runner/module.js";
import { isolateNodeTestCliContext } from "./composition/command-host.js";

isolateNodeTestCliContext();
await runProcessMandatoryNodeTests();
