import assert from "node:assert/strict";
const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
const pkg = { version: "1.0.0", integrity: `sha512-${"A".repeat(86)}==` };
export const validCohortV3 = (policyDigest: string) => ({
  schemaVersion: 3,
  cohortId: "candidate-v3",
  channel: "rc",
  recordDigest: digest("1"),
  qualificationEventDigest: digest("2"),
  eligibleAfter: "2026-09-28T00:00:00Z",
  upgradeFrom: ["prior-v2"],
  rollbackTo: ["prior-v2"],
  packages: {
    repositoryMutation: pkg,
    documentAuthoring: pkg,
    docsProtocol: pkg,
    docsProtocolAgentTeams: pkg,
    engineeringFoundation: pkg,
  },
  workflow: {
    repository: "agent-teams-ai/.github",
    path: ".github/workflows/docs-protocol-check.yml",
    revision: "a".repeat(40),
    blobSha: "b".repeat(40),
  },
  assets: {
    skillDigest: digest("3"),
    callerWorkflowDigest: digest("4"),
    assetCatalogDigest: digest("5"),
    transitionCatalogDigest: digest("6"),
  },
  schemas: { consumerIntegration: 4, managedState: 3, qualificationReceipt: 1, docsProtocol: 1 },
  candidateDigest: digest("9"),
  runtime: {
    policy: {
      id: "agent-teams.docs-protocol-current-policy",
      version: "3.0.0",
      digest: policyDigest,
    },
    selectedLane: "node-26-managed-qualified",
    node: ">=26.0.0 <27",
    pnpm: ">=11.17.0 <12",
    qualificationRuntime: {
      nodeVersion: "26.11.1",
      pnpmVersion: "11.20.0",
      platform: "linux",
      architecture: "x64",
    },
    runtimeClosure: { domain: "agent-teams.docs-runtime-closure/v2", digest: digest("7") },
  },
  lifecycleState: "QUALIFIED",
  canaryRepositoryIds: ["1"],
});

export async function assertPreservedPolicyDocuments(
  read: (path: string) => Promise<Buffer>,
  hash: (bytes: Uint8Array) => string,
): Promise<void> {
  assert.equal(
    hash(await read("../../architecture/foundation/docs-protocol-current-policy.json")),
    "sha256:b446075de07aa2655561e0cba7d15ed13cc2062b91303e961f06b6afddb18efc",
  );
  assert.equal(
    hash(await read("../../architecture/contracts/docs-protocol-current-policy/v1.schema.json")),
    "sha256:3067433b3e5b8f964049f5b83dc29ac06bb32d6c88ac3d39eee3ad7769bd6f70",
  );
  assert.equal(
    hash(await read("../../architecture/foundation/docs-protocol-current-policy-v2.json")),
    "sha256:4db0b267a08c75d22eeddde9bdf69b70c0da0b165bb13e18d6e685df4a5cd801",
  );
  assert.equal(
    hash(await read("../../architecture/contracts/docs-protocol-current-policy/v2.schema.json")),
    "sha256:2c764ddd8065ca06ee55b1e7a09947d4fe8ab70125c1533bc5d9213e79842733",
  );
}
