import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

const schemaRoot = new URL("../schemas/", import.meta.url);
const [cohortSchema, managedStateSchema] = await Promise.all([
  readFile(new URL("qualified-docs-cohort/v2.schema.json", schemaRoot), "utf8"),
  readFile(new URL("docs-consumer-managed-state/v2.schema.json", schemaRoot), "utf8")
]);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(JSON.parse(cohortSchema));
const validate = ajv.compile(JSON.parse(managedStateSchema));

const digest = (character) => `sha256:${character.repeat(64)}`;
const integrity = (character) => `sha512-${character.repeat(86)}==`;

function validManagedState() {
  const packageCoordinate = { version: "1.2.3", integrity: integrity("A") };
  return {
    schemaVersion: 2,
    cohortId: "docs-2026-09-04-stable1",
    cohortAuthority: {
      channel: "stable",
      recordDigest: digest("1"),
      qualificationEventDigest: digest("2"),
      eligibleAfter: "2026-09-04T12:00:00Z",
      upgradeFrom: ["docs-2026-09-03-stable1"],
      rollbackTo: ["docs-2026-09-03-stable1"]
    },
    repository: {
      provider: "github",
      id: "123456789",
      nameWithOwner: "agent-teams-ai/docs-sandbox"
    },
    packages: {
      repositoryMutation: packageCoordinate,
      documentAuthoring: packageCoordinate,
      docsProtocol: packageCoordinate,
      docsProtocolAgentTeams: packageCoordinate,
      engineeringFoundation: packageCoordinate
    },
    schemas: {
      consumerIntegration: 3,
      managedState: 2,
      docsProtocol: 1
    },
    runtime: {
      node: ">=24.18.0 <25",
      pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: digest("3")
    },
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    assets: {
      skillDigest: digest("4"),
      callerWorkflowDigest: digest("5"),
      assetCatalogDigest: digest("6"),
      transitionCatalogDigest: digest("7"),
      agentsRouteDigest: digest("8"),
      docsScriptsDigest: digest("9")
    },
    stateDigest: digest("a")
  };
}

test("accepts managed-state v2 only with the complete five-package cohort", () => {
  assert.equal(validate(validManagedState()), true, JSON.stringify(validate.errors));
});

test("rejects missing, additional, and malformed managed package coordinates", () => {
  const missing = validManagedState();
  delete missing.packages.repositoryMutation;
  assert.equal(validate(missing), false);

  const additional = validManagedState();
  additional.packages.unmanagedPackage = additional.packages.docsProtocol;
  assert.equal(validate(additional), false);

  const malformed = validManagedState();
  malformed.packages.documentAuthoring = {
    version: "latest",
    integrity: malformed.packages.documentAuthoring.integrity
  };
  assert.equal(validate(malformed), false);
});

test("rejects legacy or inferred schema versions", () => {
  for (const schemaVersion of [1, 3, undefined]) {
    const candidate = validManagedState();
    if (schemaVersion === undefined) {
      delete candidate.schemaVersion;
    } else {
      candidate.schemaVersion = schemaVersion;
    }
    assert.equal(validate(candidate), false);
  }

  const legacyTuple = validManagedState();
  legacyTuple.schemas = {
    consumerIntegration: 1,
    managedState: 1,
    docsProtocol: 1
  };
  assert.equal(validate(legacyTuple), false);
});

test("rejects unknown properties at every managed-state object boundary", () => {
  const unknownRoot = { ...validManagedState(), inferredLegacyState: true };
  assert.equal(validate(unknownRoot), false);

  for (const boundary of [
    "cohortAuthority",
    "repository",
    "packages",
    "schemas",
    "runtime",
    "assets"
  ]) {
    const unknownNested = validManagedState();
    unknownNested[boundary].inferredLegacyState = true;
    assert.equal(validate(unknownNested), false, boundary);
  }
});
