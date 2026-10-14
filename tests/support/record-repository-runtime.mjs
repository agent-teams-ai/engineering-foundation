import { appendFileSync } from "node:fs";

const observationPath = process.env.AGENT_TEAMS_FOUNDATION_RUNTIME_OBSERVATION;
if (observationPath === undefined || observationPath.length === 0) {
  throw new Error("Runtime observation output path is required.");
}
appendFileSync(observationPath, `${JSON.stringify({
  managerUserAgent: process.env.npm_config_user_agent ?? null,
  managerExecPath: process.env.npm_execpath ?? null,
  lifecycleEvent: process.env.npm_lifecycle_event ?? null,
  profile: process.env.AGENT_TEAMS_FOUNDATION_RUNTIME_PROFILE ?? null,
  leafExecPath: process.execPath,
  leafNodeVersion: process.versions.node,
  leafBunVersion: process.versions.bun ?? null
})}\n`, "utf8");
