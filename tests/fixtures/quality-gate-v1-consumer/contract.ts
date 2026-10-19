import { createQualityGateCommand } from "../../../packages/engineering-foundation/dist/capabilities/quality-gate-runner/api.js";
import type { QualityGatePolicyLoader } from "../../../packages/engineering-foundation/dist/capabilities/quality-gate-runner/application/ports/quality-gate-policy-loader.js";

const oldTypedPolicyLoader: QualityGatePolicyLoader = async () => ({
  packageManager: "pnpm",
  profiles: [{
    id: "verify",
    concurrency: 1,
    tasks: [{ id: "test", needs: [], after: [] }]
  }]
});

void createQualityGateCommand({
  catalogReader: { read: async () => ({ scripts: { test: "node test.mjs" } }) },
  clock: { nowMs: () => 0 },
  executor: { run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) },
  policyLoader: oldTypedPolicyLoader
});
