import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";

import {
  assertQualifiedPnpmLockfileV2
} from "../dist/consumer-integration/adapters/pnpm-lockfile-validator-v2.js";
import {
  computePnpmRuntimeClosureDigestV2
} from "../dist/consumer-integration/adapters/pnpm-runtime-closure-v2.js";

const coordinate = Object.freeze({
  version: "0.1.0",
  integrity: `sha512-${"A".repeat(86)}==`
});

const desired = Object.freeze({
  cohort: Object.freeze({
    packages: Object.freeze({
      repositoryMutation: coordinate,
      documentAuthoring: coordinate,
      docsProtocol: coordinate,
      docsProtocolAgentTeams: coordinate,
      engineeringFoundation: coordinate
    }),
    runtime: Object.freeze({ runtimeClosureDigest: `sha256:${"0".repeat(64)}` })
  })
});

function assertOverrideRejected(field, selector) {
  const lockfile = `lockfileVersion: '9.0'
${field}:
  '${selector}': 0.1.0
`;
  assert.throws(
    () => assertQualifiedPnpmLockfileV2(Buffer.from(lockfile), desired),
    (error) => {
      assert.equal(error?.code, "DOCS_CONSUMER_LOCKFILE_OVERRIDE");
      return true;
    }
  );
}

test("Cohort v2 rejects a repository-mutation override", () => {
  assertOverrideRejected("overrides", "@agent-teams/repository-mutation");
});

test("Cohort v2 rejects a document-authoring patch", () => {
  assertOverrideRejected("patchedDependencies", "@agent-teams/document-authoring@0.1.0");
});

function assertLockfileAliasRejected(importerPath, field, target) {
  const nested = importerPath === "." ? "" : `  '${importerPath}':
    ${field}:
      managedAlias:
        specifier: 'npm:${target}@0.1.0'
        version: 'npm:${target}@0.1.0'
`;
  const root = importerPath === "." ? `  .:
    ${field}:
      managedAlias:
        specifier: 'npm:${target}@0.1.0'
        version: 'npm:${target}@0.1.0'
` : "  .: {}\n";
  const lockfile = `lockfileVersion: '9.0'
importers:
${root}
${nested}`;
  assert.throws(
    () => assertQualifiedPnpmLockfileV2(Buffer.from(lockfile), desired),
    (error) => {
      assert.equal(error?.code, "DOCS_CONSUMER_COHORT_ALIAS_FORBIDDEN");
      return true;
    }
  );
}

test("Cohort v2 rejects npm aliases in root and nested importers", () => {
  assertLockfileAliasRejected(
    ".",
    "devDependencies",
    "@agent-teams/repository-mutation"
  );
  assertLockfileAliasRejected(
    "packages/nested",
    "peerDependencies",
    "@agent-teams/document-authoring"
  );
});

test("Cohort v2 rejects a catalog alias resolved to a Cohort identity", () => {
  const lockfile = `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      rmAlias:
        specifier: 'catalog:managed'
        version: '@agent-teams/repository-mutation@0.1.0'
`;
  assert.throws(
    () => assertQualifiedPnpmLockfileV2(Buffer.from(lockfile), desired),
    (error) => {
      assert.equal(error?.code, "DOCS_CONSUMER_COHORT_ALIAS_FORBIDDEN");
      return true;
    }
  );
});

function hostileCyclicLockfile() {
  const packageNames = [
    "@agent-teams/repository-mutation",
    "@agent-teams/document-authoring",
    "@agent-teams/docs-protocol",
    "@agent-teams/docs-protocol-agent-teams",
    "@agent-teams/engineering-foundation"
  ];
  const dependencies = (entries) => Object.fromEntries(
    entries.map((name) => [name, coordinate.version])
  );
  return {
    lockfileVersion: "9.0",
    importers: {
      ".": {
        devDependencies: Object.fromEntries([
          "@agent-teams/docs-protocol",
          "@agent-teams/docs-protocol-agent-teams",
          "@agent-teams/engineering-foundation"
        ].map((name) => [name, {
          specifier: coordinate.version,
          version: coordinate.version
        }]))
      }
    },
    packages: Object.fromEntries(packageNames.map((name) => [
      `${name}@${coordinate.version}`,
      { resolution: { integrity: coordinate.integrity } }
    ])),
    snapshots: {
      "@agent-teams/repository-mutation@0.1.0": {
        dependencies: dependencies(["@agent-teams/docs-protocol"])
      },
      "@agent-teams/document-authoring@0.1.0": {
        dependencies: dependencies(["@agent-teams/repository-mutation"])
      },
      "@agent-teams/docs-protocol@0.1.0": {
        dependencies: dependencies([
          "@agent-teams/document-authoring",
          "@agent-teams/repository-mutation"
        ])
      },
      "@agent-teams/docs-protocol-agent-teams@0.1.0": {
        dependencies: dependencies([
          "@agent-teams/docs-protocol",
          "@agent-teams/repository-mutation"
        ])
      },
      "@agent-teams/engineering-foundation@0.1.0": {
        dependencies: dependencies([
          "@agent-teams/document-authoring",
          "@agent-teams/repository-mutation"
        ])
      }
    }
  };
}

test("Cohort v2 rejects a digest-bound extra managed edge that creates a cycle", () => {
  const lockfile = hostileCyclicLockfile();
  const cohort = {
    ...desired.cohort,
    runtime: {
      runtimeClosureDigest: computePnpmRuntimeClosureDigestV2(lockfile, desired.cohort)
    }
  };
  assert.throws(
    () => assertQualifiedPnpmLockfileV2(
      Buffer.from(stringify(lockfile)),
      { ...desired, cohort }
    ),
    (error) => {
      assert.equal(error?.code, "DOCS_CONSUMER_COHORT_DEPENDENCY_MISMATCH");
      assert.match(error.message, /forbidden extra Cohort dependency/u);
      return true;
    }
  );
});

test("Cohort v2 rejects a required managed edge represented as optional", () => {
  const lockfile = hostileCyclicLockfile();
  delete lockfile.snapshots["@agent-teams/repository-mutation@0.1.0"].dependencies;
  const authoring = lockfile.snapshots["@agent-teams/document-authoring@0.1.0"];
  authoring.optionalDependencies = authoring.dependencies;
  delete authoring.dependencies;
  const cohort = {
    ...desired.cohort,
    runtime: {
      runtimeClosureDigest: computePnpmRuntimeClosureDigestV2(lockfile, desired.cohort)
    }
  };
  assert.throws(
    () => assertQualifiedPnpmLockfileV2(
      Buffer.from(stringify(lockfile)),
      { ...desired, cohort }
    ),
    (error) => {
      assert.equal(error?.code, "DOCS_CONSUMER_COHORT_DEPENDENCY_MISMATCH");
      assert.match(error.message, /must not optionally depend/u);
      return true;
    }
  );
});
