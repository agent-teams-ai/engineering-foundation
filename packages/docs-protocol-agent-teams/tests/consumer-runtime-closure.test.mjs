import assert from "node:assert/strict";
import test from "node:test";

import {
  computePnpmRuntimeClosureDigestV1
} from "../dist/consumer-integration/adapters/pnpm-runtime-closure-v1.js";

const integrity = (character) => `sha512-${character.repeat(86)}==`;

function cohort() {
  return {
    packages: {
      docsProtocol: { version: "0.2.0-rc.0", integrity: integrity("A") },
      engineeringFoundation: { version: "0.18.0-rc.0", integrity: integrity("B") }
    }
  };
}

function runtimeClosureGoldenLock() {
  return {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: {
      ".": {
        devDependencies: {
          "@agent-teams/docs-protocol": {
            specifier: "0.2.0-rc.0",
            version: "0.2.0-rc.0(peer-package@1.0.0)"
          },
          "@agent-teams/engineering-foundation": {
            specifier: "0.18.0-rc.0",
            version: "0.18.0-rc.0"
          }
        }
      }
    },
    packages: {
      "@agent-teams/docs-protocol@0.2.0-rc.0": { resolution: { integrity: integrity("A") } },
      "@agent-teams/engineering-foundation@0.18.0-rc.0": {
        resolution: { integrity: integrity("B") }
      },
      "peer-package@1.0.0": { resolution: { integrity: integrity("C") } },
      "transitive-package@2.0.0": { resolution: { integrity: integrity("D") } }
    },
    snapshots: {
      "@agent-teams/docs-protocol@0.2.0-rc.0(peer-package@1.0.0)": {
        dependencies: { "@agent-teams/engineering-foundation": "0.18.0-rc.0" },
        optionalDependencies: { "peer-package": "1.0.0" }
      },
      "@agent-teams/engineering-foundation@0.18.0-rc.0": {
        dependencies: { "transitive-package": "2.0.0" }
      },
      "peer-package@1.0.0": {},
      "transitive-package@2.0.0": {}
    }
  };
}

function withNodeTypesPeerContext(lock) {
  const augmented = structuredClone(lock);
  augmented.importers["."].devDependencies["@types/node"] = {
    specifier: "24.13.3",
    version: "24.13.3"
  };
  augmented.packages["@types/node@24.13.3"] = { resolution: { integrity: integrity("N") } };
  augmented.packages["transitive-package@2.0.0"].peerDependencies = { "@types/node": "*" };
  augmented.packages["transitive-package@2.0.0"].peerDependenciesMeta = {
    "@types/node": { optional: true }
  };
  augmented.snapshots["@agent-teams/docs-protocol@0.2.0-rc.0(peer-package@1.0.0)(@types/node@24.13.3)"] = {
    dependencies: {
      "@agent-teams/engineering-foundation": "0.18.0-rc.0(@types/node@24.13.3)"
    },
    optionalDependencies: { "peer-package": "1.0.0" },
    transitivePeerDependencies: ["@types/node", "runtime-peer"]
  };
  augmented.snapshots["@agent-teams/engineering-foundation@0.18.0-rc.0(@types/node@24.13.3)"] = {
    dependencies: { "transitive-package": "2.0.0(@types/node@24.13.3)" },
    transitivePeerDependencies: ["@types/node"]
  };
  augmented.snapshots["transitive-package@2.0.0(@types/node@24.13.3)"] = {
    optionalDependencies: { "@types/node": "24.13.3" }
  };
  delete augmented.snapshots["@agent-teams/docs-protocol@0.2.0-rc.0(peer-package@1.0.0)"];
  delete augmented.snapshots["@agent-teams/engineering-foundation@0.18.0-rc.0"];
  delete augmented.snapshots["transitive-package@2.0.0"];
  augmented.importers["."].devDependencies["@agent-teams/docs-protocol"].version =
    "0.2.0-rc.0(peer-package@1.0.0)(@types/node@24.13.3)";
  augmented.importers["."].devDependencies["@agent-teams/engineering-foundation"].version =
    "0.18.0-rc.0(@types/node@24.13.3)";
  return augmented;
}

test("matches the governance golden for peer, optional, and transitive edges", () => {
  assert.equal(
    computePnpmRuntimeClosureDigestV1(runtimeClosureGoldenLock(), cohort()),
    "sha256:beb826880ec8424605ecb96c7ba8183314d621ab76a992aa4945cf881f61e0ec"
  );
});

test("ignores only the type-only Node peer context added by a typed consumer", () => {
  const baseline = runtimeClosureGoldenLock();
  baseline.snapshots["@agent-teams/docs-protocol@0.2.0-rc.0(peer-package@1.0.0)"]
    .transitivePeerDependencies = ["@types/node", "runtime-peer"];
  baseline.snapshots["@agent-teams/engineering-foundation@0.18.0-rc.0"]
    .transitivePeerDependencies = ["@types/node"];
  baseline.packages["transitive-package@2.0.0"].peerDependencies = { "@types/node": "*" };
  baseline.packages["transitive-package@2.0.0"].peerDependenciesMeta = {
    "@types/node": { optional: true }
  };
  assert.equal(
    computePnpmRuntimeClosureDigestV1(withNodeTypesPeerContext(baseline), cohort()),
    computePnpmRuntimeClosureDigestV1(baseline, cohort())
  );
});

test("detects reachable SRI drift and rejects alias edges", () => {
  const drifted = structuredClone(runtimeClosureGoldenLock());
  drifted.packages["transitive-package@2.0.0"].resolution.integrity = integrity("E");
  assert.notEqual(
    computePnpmRuntimeClosureDigestV1(drifted, cohort()),
    computePnpmRuntimeClosureDigestV1(runtimeClosureGoldenLock(), cohort())
  );

  const aliased = structuredClone(runtimeClosureGoldenLock());
  aliased.snapshots["@agent-teams/engineering-foundation@0.18.0-rc.0"].dependencies = {
    "transitive-package": "npm:other-package@2.0.0"
  };
  assert.throws(
    () => computePnpmRuntimeClosureDigestV1(aliased, cohort()),
    (error) => error?.code === "DOCS_CONSUMER_RUNTIME_CLOSURE_MISMATCH" &&
      /bounded registry|non-registry or aliased/u.test(error.message)
  );
});

test("rejects a partial managed lock graph with a missing reachable snapshot", () => {
  const partial = structuredClone(runtimeClosureGoldenLock());
  delete partial.snapshots["@agent-teams/engineering-foundation@0.18.0-rc.0"];
  assert.throws(
    () => computePnpmRuntimeClosureDigestV1(partial, cohort()),
    (error) => error?.code === "DOCS_CONSUMER_RUNTIME_CLOSURE_MISMATCH"
  );
});
