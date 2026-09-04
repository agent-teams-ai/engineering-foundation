import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  canonicalCallerWorkflow,
  canonicalManagedState,
  describeCanonicalConsumerAssets
} from "../dist/consumer-integration/index.js";
import {
  CANONICAL_CALLER_WORKFLOW_TEMPLATE,
  canonicalConsumerIntegrationJson
} from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";

const digest = (character) => `sha256:${character.repeat(64)}`;
const integrity = (character) => `sha512-${character.repeat(86)}==`;

const schemaRoot = new URL("../schemas/", import.meta.url);
const [cohortSchema, managedStateSchema] = await Promise.all([
  readFile(new URL("qualified-docs-cohort/v2.schema.json", schemaRoot), "utf8"),
  readFile(new URL("docs-consumer-managed-state/v2.schema.json", schemaRoot), "utf8")
]);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(JSON.parse(cohortSchema));
const validateManagedStateV2 = ajv.compile(JSON.parse(managedStateSchema));

const workflow = Object.freeze({
  repository: "agent-teams-ai/.github",
  path: ".github/workflows/docs-protocol-check.yml",
  revision: "1".repeat(40),
  blobSha: "2".repeat(40)
});

const assetCoordinates = Object.freeze({
  skillDigest: digest("3"),
  callerWorkflowDigest: digest("4"),
  assetCatalogDigest: digest("5"),
  transitionCatalogDigest: digest("6")
});

const managedAssets = Object.freeze({
  ...assetCoordinates,
  agentsRouteDigest: digest("7"),
  docsScriptsDigest: digest("8")
});

function desiredV1() {
  return {
    schemaVersion: 1,
    repository: {
      provider: "github",
      id: "123456789",
      nameWithOwner: "agent-teams-ai/docs-sandbox"
    },
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    cohort: {
      schemaVersion: 1,
      cohortId: "docs-2026-09-03-stable1",
      channel: "stable",
      recordDigest: digest("9"),
      qualificationEventDigest: digest("a"),
      eligibleAfter: "2026-09-03T12:00:00Z",
      upgradeFrom: ["docs-2026-09-02-stable1"],
      rollbackTo: ["docs-2026-09-02-stable1"],
      packages: {
        docsProtocol: { version: "0.4.0", integrity: integrity("A") },
        engineeringFoundation: { version: "0.19.0", integrity: integrity("B") }
      },
      workflow,
      assets: assetCoordinates,
      schemas: { consumerIntegration: 1, managedState: 1, docsProtocol: 1 },
      runtime: {
        node: ">=24.18.0 <25",
        pnpm: ">=11.17.0 <12",
        runtimeClosureDigest: digest("b")
      }
    }
  };
}

function desiredV3() {
  const packageCoordinate = { version: "1.2.3", integrity: integrity("C") };
  return {
    schemaVersion: 3,
    repository: {
      provider: "github",
      id: "123456789",
      nameWithOwner: "agent-teams-ai/docs-sandbox"
    },
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    qualification: {
      contractPath: "architecture/foundation/docs-protocol-qualification.json",
      gateCommand: "pnpm docs:protocol:check"
    },
    cohort: {
      schemaVersion: 2,
      cohortId: "docs-2026-09-04-stable1",
      channel: "stable",
      recordDigest: digest("c"),
      qualificationEventDigest: digest("d"),
      eligibleAfter: "2026-09-04T12:00:00Z",
      upgradeFrom: ["docs-2026-09-03-stable1"],
      rollbackTo: ["docs-2026-09-03-stable1"],
      packages: {
        repositoryMutation: packageCoordinate,
        documentAuthoring: packageCoordinate,
        docsProtocol: packageCoordinate,
        docsProtocolAgentTeams: packageCoordinate,
        engineeringFoundation: packageCoordinate
      },
      workflow,
      assets: assetCoordinates,
      schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
      runtime: {
        node: ">=24.18.0 <25",
        pnpm: ">=11.17.0 <12",
        runtimeClosureDigest: digest("e")
      }
    }
  };
}

test("keeps the canonical managed-state v1 byte contract unchanged", () => {
  const bytes = canonicalManagedState(desiredV1(), managedAssets);
  const outputDigest = createHash("sha256").update(bytes).digest("hex");

  assert.equal(outputDigest, "3c6bd219daf623f096c9293fdb33db67f9b1c62a152dd217d20c79663a2411de");
});

test("renders managed-state v2 from only an explicit profile v3 and five-package cohort", () => {
  const desired = desiredV3();
  const serialized = canonicalManagedState(desired, managedAssets);
  const state = JSON.parse(serialized);
  const { stateDigest, ...body } = state;
  const expectedStateDigest = `sha256:${createHash("sha256").update(
    canonicalConsumerIntegrationJson({
      domain: "agent-teams.docs-protocol.managed-state/v2",
      body
    })
  ).digest("hex")}`;

  assert.equal(serialized.endsWith("\n"), true);
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(Object.keys(state.packages).toSorted(), [
    "docsProtocol",
    "docsProtocolAgentTeams",
    "documentAuthoring",
    "engineeringFoundation",
    "repositoryMutation"
  ]);
  assert.deepEqual(state.schemas, {
    consumerIntegration: 3,
    docsProtocol: 1,
    managedState: 2
  });
  assert.equal(stateDigest, expectedStateDigest);
  assert.equal(serialized, `${canonicalConsumerIntegrationJson(state)}\n`);
  assert.equal(Object.hasOwn(state, "qualification"), false);
  assert.equal(validateManagedStateV2(state), true, JSON.stringify(validateManagedStateV2.errors));
});

test("uses the same canonical workflow and asset description for cohort bindings v1 and v2", () => {
  const v1 = desiredV1().cohort;
  const v2 = desiredV3().cohort;
  const expectedWorkflow = CANONICAL_CALLER_WORKFLOW_TEMPLATE
    .replace("{{REUSABLE_WORKFLOW_REPOSITORY}}", workflow.repository)
    .replace("{{REUSABLE_WORKFLOW_PATH}}", workflow.path)
    .replace("{{REUSABLE_WORKFLOW_REVISION}}", workflow.revision);

  assert.equal(canonicalCallerWorkflow(v1), expectedWorkflow);
  assert.equal(canonicalCallerWorkflow(v2), expectedWorkflow);
  assert.deepEqual(describeCanonicalConsumerAssets(v1), describeCanonicalConsumerAssets(v2));
});
