import assert from "node:assert/strict";
import test from "node:test";

import {
  assertQualifiedPnpmLockfileV1
} from "../dist/consumer-integration/adapters/pnpm-lockfile-validator-v1.js";

const integrity = `sha512-${"A".repeat(86)}==`;

test("V1 selects the importer snapshot and permits an unused peer-context snapshot", () => {
  const desired = {
    cohort: {
      packages: {
        docsProtocol: { version: "1.0.0", integrity },
        engineeringFoundation: { version: "2.0.0", integrity }
      },
      runtime: { runtimeClosureDigest: `sha256:${"0".repeat(64)}` }
    }
  };
  const lockfile = `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@agent-teams/docs-protocol':
        specifier: 1.0.0
        version: 1.0.0(peer-package@1.0.0)
      '@agent-teams/engineering-foundation':
        specifier: 2.0.0
        version: 2.0.0
    dependencies:
      docsAlias:
        specifier: 'npm:@agent-teams/docs-protocol@1.0.0'
        version: 'npm:@agent-teams/docs-protocol@1.0.0'
packages:
  '@agent-teams/docs-protocol@1.0.0':
    resolution: {integrity: ${integrity}}
  '@agent-teams/engineering-foundation@2.0.0':
    resolution: {integrity: ${integrity}}
snapshots:
  '@agent-teams/docs-protocol@1.0.0(peer-package@1.0.0)':
    dependencies:
      '@agent-teams/engineering-foundation': 2.0.0
  '@agent-teams/docs-protocol@1.0.0(peer-package@9.9.9)':
    dependencies:
      '@agent-teams/engineering-foundation': 2.0.0
  '@agent-teams/engineering-foundation@2.0.0': {}
`;

  assert.doesNotThrow(() =>
    assertQualifiedPnpmLockfileV1(Buffer.from(lockfile), desired)
  );
});
