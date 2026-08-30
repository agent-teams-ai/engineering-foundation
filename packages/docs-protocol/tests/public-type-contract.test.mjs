import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const LEGACY_MANAGED_TYPE_EXPORTS = [
  "AgentsRoutePlanV1",
  "ConsumerIntegrationAssetPlan",
  "ConsumerIntegrationAssetState",
  "ConsumerIntegrationDesiredStateV1",
  "ConsumerIntegrationDigest",
  "ConsumerIntegrationExecutionV1",
  "ConsumerIntegrationFileObservation",
  "ConsumerIntegrationIssue",
  "ConsumerIntegrationPlanV1",
  "ConsumerIntegrationSnapshot",
  "ConsumerUpgradeAuthorityV1",
  "ConsumerUpgradeExecutionV1",
  "PnpmManifestPlanV1",
  "QualifiedDocsCohortBindingV1",
  "QualifiedDocsCohortV1"
];

test("public declarations preserve result and managed compatibility contracts", async () => {
  const [api, application, root, managedCompatibility, managedAuthority] = await Promise.all([
    readFile(new URL("../dist/composition/node-docs-api.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/application/docs-protocol.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8"),
    readFile(new URL(
      "../dist/consumer-integration/composition/canonical-docs-skill-v2.d.ts",
      import.meta.url
    ), "utf8"),
    readFile(new URL("../dist/consumer-integration/index.d.ts", import.meta.url), "utf8")
  ]);
  assert.match(api, /docsNew\(input: DocsNewRequest\): Promise<DocsExecution<DocsNewResult>>/u);
  assert.match(application, /newDocument\(request: DocsNewRequest\): Promise<DocsExecution<DocsNewResult>>/u);
  assert.match(root, /DocsNewResult/u);
  assert.doesNotMatch(api, /DocsExecution<Readonly<\{\}>>/u);
  assert.match(
    root,
    /export \{ CANONICAL_DOCS_SKILL_V2, consumerIntegration \} from "\.\/consumer-integration\/composition\/canonical-docs-skill-v2\.js";/u
  );
  assert.match(
    managedCompatibility,
    /export \* as consumerIntegration from "\.\.\/index\.js";/u
  );
  assert.match(
    managedCompatibility,
    /export \{ CANONICAL_DOCS_SKILL_V2 \} from "\.\.\/application\/policies\/consumer-integration-assets\.js";/u
  );
  const managedTypeExports = [...managedAuthority.matchAll(
    /export type \{([^}]+)\} from/gu
  )].flatMap(([, names]) => names.split(",").map((name) => name.trim())).toSorted();
  assert.deepEqual(managedTypeExports, LEGACY_MANAGED_TYPE_EXPORTS);
});
