import { createPnpmRunner } from "../../scripts/pack-test-support.mjs";
import { runStagedPackageBuild } from "../../scripts/pack-artifact-stage-support.mjs";

const stage = process.argv[2];
if (stage === undefined) { throw new Error("TEST build stage required"); }
await runStagedPackageBuild(createPnpmRunner(), stage);
