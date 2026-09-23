#!/usr/bin/env node

import { runProcessMandatoryNodeTests } from "./capabilities/quality-gate-runner/module.js";

await runProcessMandatoryNodeTests();
