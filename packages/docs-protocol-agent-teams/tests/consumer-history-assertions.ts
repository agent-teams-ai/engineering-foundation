import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { QualifiedDocsCohortBindingV2 } from "../dist/consumer-integration/index.js";
interface HistoricalBundle {
  cohort: QualifiedDocsCohortBindingV2;
  skillPath: string;
  skillDigest: string;
  callerWorkflowPath: string;
  callerWorkflowDigest: string;
}
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export async function assertStable25RetainedBinding(
  stable25: HistoricalBundle,
  stable26: HistoricalBundle,
): Promise<void> {
  assert.equal(
    stable25.cohort.recordDigest,
    "sha256:105c34ecc7fc422939b43daaca513f9ce630ce69d4a2820d39423fcdc13dcc61",
  );
  assert.equal(
    stable25.cohort.qualificationEventDigest,
    "sha256:090325fe7992c7ca15e03a5375188d006d8c410f7a895a219fafb4e735f5d28b",
  );
  assert.deepEqual(stable25.cohort.upgradeFrom, ["docs-2026-09-12-stable21"]);
  assert.deepEqual(stable25.cohort.rollbackTo, ["docs-2026-09-12-stable21"]);
  assert.deepEqual(stable25.cohort.assets, stable26.cohort.assets);
  assert.deepEqual(stable25.cohort.workflow, stable26.cohort.workflow);
  assert.deepEqual(stable25.cohort.schemas, {
    consumerIntegration: 3,
    managedState: 2,
    docsProtocol: 1,
  });
  assert.equal(
    stable25.cohort.runtime.runtimeClosureDigest,
    "sha256:87cb5e3495848f453c1ac0e4dc8caa7d66828f0cab270cefd46d73dee2ea341a",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(stable25.cohort.packages).map(([name, { version }]) => [name, version]),
    ),
    {
      repositoryMutation: "0.2.0",
      documentAuthoring: "0.3.0",
      docsProtocol: "0.6.0",
      docsProtocolAgentTeams: "0.2.9",
      engineeringFoundation: "1.4.0",
    },
  );
  assert.deepEqual(
    stable25.cohort.packages.repositoryMutation,
    stable26.cohort.packages.repositoryMutation,
  );
  assert.deepEqual(
    stable25.cohort.packages.documentAuthoring,
    stable26.cohort.packages.documentAuthoring,
  );
  assert.deepEqual(stable25.cohort.packages.docsProtocol, stable26.cohort.packages.docsProtocol);
  assert.deepEqual(
    stable25.cohort.packages.docsProtocolAgentTeams,
    stable26.cohort.packages.docsProtocolAgentTeams,
  );
  assert.equal(
    stable25.cohort.packages.engineeringFoundation.integrity,
    "sha512-m8rLOvctyXu+kqN4LyCW4LIz303a7p+ZIvx+oieYIwst6DNBpsWUu/Ux7UZM3fZH5JTYhB4eSEBEfi5lUTt4vQ==",
  );
  for (const [path, expected] of [
    [stable25.skillPath, stable25.skillDigest],
    [stable25.callerWorkflowPath, stable25.callerWorkflowDigest],
  ] as const) {
    assert.equal(digest(await readFile(join(import.meta.dirname, "..", path))), expected);
  }
}
