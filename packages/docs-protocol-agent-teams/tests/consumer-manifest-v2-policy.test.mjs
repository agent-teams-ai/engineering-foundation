import assert from "node:assert/strict";
import test from "node:test";

import {
  planPnpmManifestV2,
  projectPnpmManifestCohortPinsV2
} from "../dist/consumer-integration/adapters/pnpm-manifest-adapter-v2.js";
import {
  planPnpmManifestV1,
  projectPnpmManifestCohortPinsV1
} from "../dist/consumer-integration/adapters/pnpm-manifest-adapter-v1.js";

const coordinate = (version) => ({
  version,
  integrity: `sha512-${"A".repeat(86)}==`
});

const cohort = Object.freeze({
  packages: Object.freeze({
    repositoryMutation: coordinate("1.0.0"),
    documentAuthoring: coordinate("1.1.0"),
    docsProtocol: coordinate("2.0.0"),
    docsProtocolAgentTeams: coordinate("2.1.0"),
    engineeringFoundation: coordinate("3.0.0")
  })
});

const transitiveNames = Object.freeze([
  "@agent-teams/repository-mutation",
  "@agent-teams/document-authoring"
]);
const directPins = Object.freeze({
  "@agent-teams/docs-protocol": "2.0.0",
  "@agent-teams/docs-protocol-agent-teams": "2.1.0",
  "@agent-teams/engineering-foundation": "3.0.0"
});

function hostileManifest() {
  const declarations = Object.fromEntries(transitiveNames.map((name) => [name, "0.0.1"]));
  return {
    name: "hostile-consumer",
    private: true,
    dependencies: { unrelatedDependency: "1.0.0", ...declarations },
    devDependencies: { unrelatedDevDependency: "1.0.0", ...declarations },
    optionalDependencies: { unrelatedOptionalDependency: "1.0.0", ...declarations },
    peerDependencies: { unrelatedPeerDependency: "1.0.0", ...declarations }
  };
}

test("V2 upgrade projection removes transitive roots and projects exactly three direct pins", () => {
  const projected = JSON.parse(Buffer.from(projectPnpmManifestCohortPinsV2({
    bytes: Buffer.from(`${JSON.stringify(hostileManifest(), null, 2)}\n`),
    cohort
  })).toString("utf8"));

  for (const field of [
    "dependencies", "devDependencies", "optionalDependencies", "peerDependencies"
  ]) {
    for (const packageName of transitiveNames) {
      assert.equal(projected[field][packageName], undefined, `${field}.${packageName}`);
    }
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(projected.devDependencies)
      .filter(([name]) => name.startsWith("@agent-teams/"))),
    directPins
  );
  assert.equal(projected.dependencies.unrelatedDependency, "1.0.0");
  assert.equal(projected.devDependencies.unrelatedDevDependency, "1.0.0");
  assert.equal(projected.optionalDependencies.unrelatedOptionalDependency, "1.0.0");
  assert.equal(projected.peerDependencies.unrelatedPeerDependency, "1.0.0");
});

test("V2 planning rejects every transitive root declaration fail-closed", () => {
  const plan = planPnpmManifestV2({
    observation: {
      state: "file",
      bytes: Buffer.from(`${JSON.stringify(hostileManifest(), null, 2)}\n`),
      mode: 0o644
    },
    profilePath: "architecture/foundation/docs-consumer-integration.json",
    cohort
  });

  assert.equal(plan.state, "conflict");
  const transitiveIssues = plan.issues.filter(({ code }) =>
    code === "DOCS_CONSUMER_TRANSITIVE_ROOT_DECLARATION"
  );
  assert.equal(transitiveIssues.length, 8);
  for (const field of [
    "dependencies", "devDependencies", "optionalDependencies", "peerDependencies"
  ]) {
    for (const packageName of transitiveNames) {
      assert.ok(transitiveIssues.some(({ subject }) =>
        subject === `package.json#${field}.${packageName}`
      ));
    }
  }
});

function aliasManifest() {
  return {
    name: "alias-consumer",
    dependencies: {
      rmAlias: "npm:@agent-teams/repository-mutation@1.0.0"
    },
    devDependencies: {
      authoringAlias: "npm:@agent-teams/document-authoring@1.1.0"
    },
    optionalDependencies: {
      docsAlias: "npm:@agent-teams/docs-protocol@2.0.0"
    },
    peerDependencies: {
      foundationAlias: "npm:@agent-teams/engineering-foundation@3.0.0"
    }
  };
}

test("V2 projection and planning reject npm aliases to Cohort identities", () => {
  const bytes = Buffer.from(`${JSON.stringify(aliasManifest(), null, 2)}\n`);
  assert.throws(
    () => projectPnpmManifestCohortPinsV2({ bytes, cohort }),
    /must not target a Cohort package/u
  );
  const plan = planPnpmManifestV2({
    observation: { state: "file", bytes, mode: 0o644 },
    profilePath: "architecture/foundation/docs-consumer-integration.json",
    cohort
  });
  assert.equal(plan.state, "conflict");
  assert.equal(plan.issues.filter(({ code }) =>
    code === "DOCS_CONSUMER_COHORT_ALIAS_FORBIDDEN"
  ).length, 4);
});

test("V1 preserves its historical acceptance of an extra npm alias", () => {
  const v1Cohort = {
    packages: {
      docsProtocol: coordinate("1.0.0"),
      engineeringFoundation: coordinate("2.0.0")
    }
  };
  const manifest = {
    dependencies: {
      docsAlias: "npm:@agent-teams/docs-protocol@1.0.0"
    },
    devDependencies: {
      "@agent-teams/docs-protocol": "1.0.0",
      "@agent-teams/engineering-foundation": "2.0.0"
    }
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const projected = JSON.parse(Buffer.from(projectPnpmManifestCohortPinsV1({
    bytes,
    cohort: v1Cohort
  })).toString("utf8"));
  assert.equal(projected.dependencies.docsAlias, manifest.dependencies.docsAlias);
  const plan = planPnpmManifestV1({
    observation: { state: "file", bytes, mode: 0o644 },
    profilePath: "architecture/foundation/docs-consumer-integration.json",
    cohort: v1Cohort
  });
  assert.notEqual(plan.state, "conflict");
  assert.equal(plan.issues.length, 0);
});
