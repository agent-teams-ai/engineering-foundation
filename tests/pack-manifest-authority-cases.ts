import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPublishManifest } from "../scripts/pack-artifact-stage-support.mjs";

export function manifestFixtureRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

export function canonicalFixtureManifest(
  manifest: unknown,
  context: {
    catalogVersions: Map<string, string>;
    internalPackageVersions: Map<string, string>;
  },
): Record<string, unknown> {
  return manifestFixtureRecord(canonicalPublishManifest(manifest, context));
}

function assertWorkspaceCaretPeers(): void {
  const context = {
    catalogVersions: new Map(),
    internalPackageVersions: new Map([["@fixture/core", "1.8.0"]]),
  };
  assert.deepEqual(
    canonicalFixtureManifest({ peerDependencies: { "@fixture/core": "workspace:^" } }, context)[
      "peerDependencies"
    ],
    { "@fixture/core": "^1.8.0" },
  );
  assert.deepEqual(
    canonicalFixtureManifest(
      { peerDependencies: { "@fixture/core": "workspace:^" } },
      {
        ...context,
        internalPackageVersions: new Map([["@fixture/core", "1.8.0-rc.0"]]),
      },
    )["peerDependencies"],
    { "@fixture/core": "^1.8.0-rc.0" },
  );
  assert.throws(
    () =>
      canonicalPublishManifest(
        { peerDependencies: { "@fixture/core": "workspace:^" } },
        { catalogVersions: new Map(), internalPackageVersions: new Map() },
      ),
    /cannot resolve workspace version/u,
  );
  assert.throws(
    () =>
      canonicalPublishManifest(
        { optionalDependencies: { "@fixture/core": "workspace:^" } },
        context,
      ),
    /requires workspace:\*/u,
  );
}

function assertStablePeerMinimum(): void {
  const peerDependencies = { "@fixture/core": "workspace:^1.8.0" };
  for (const version of ["1.8.0", "1.9.0", "1.10.0"]) {
    const context = {
      catalogVersions: new Map(),
      internalPackageVersions: new Map([["@fixture/core", version]]),
    };
    assert.deepEqual(
      canonicalPublishManifest(
        { peerDependencies, devDependencies: { "@fixture/core": "workspace:*" } },
        context,
      ),
      {
        peerDependencies: { "@fixture/core": "^1.8.0" },
        devDependencies: { "@fixture/core": version },
      },
    );
  }
  for (const version of ["1.7.4", "2.0.0", "1.10.0-rc.0"]) {
    assert.throws(
      () =>
        canonicalPublishManifest(
          { peerDependencies },
          {
            catalogVersions: new Map(),
            internalPackageVersions: new Map([["@fixture/core", version]]),
          },
        ),
      /does not admit workspace version/u,
    );
  }
  for (const [minimum, accepted, rejected] of [
    ["0.2.3", "0.2.9", "0.3.0"],
    ["0.0.3", "0.0.3", "0.0.4"],
    ["0.0.0", "0.0.0", "0.0.1"],
  ]) {
    const peers = { peerDependencies: { "@fixture/core": `workspace:^${minimum}` } };
    const context = {
      catalogVersions: new Map(),
      internalPackageVersions: new Map([["@fixture/core", accepted]]),
    };
    assert.deepEqual(canonicalFixtureManifest(peers, context)["peerDependencies"], {
      "@fixture/core": `^${minimum}`,
    });
    assert.throws(
      () =>
        canonicalPublishManifest(peers, {
          ...context,
          internalPackageVersions: new Map([["@fixture/core", rejected]]),
        }),
      /does not admit workspace version/u,
    );
  }
  for (const specifier of [
    "workspace:^1.8",
    "workspace:^01.8.0",
    "workspace:^1.8.0-rc.0",
    "workspace:^1.8.0 || *",
    "workspace:^1.8.0 || ^2.0",
    "workspace:^1.8.0 || ^2.0.0-rc.0",
    "workspace:^1.8.0||^2.0.0",
    "workspace:^1.8.0 || >=2.0.0",
    "workspace:^1.8.0 || ",
  ]) {
    assert.throws(
      () =>
        canonicalPublishManifest(
          { peerDependencies: { "@fixture/core": specifier } },
          {
            catalogVersions: new Map(),
            internalPackageVersions: new Map([["@fixture/core", "1.9.0"]]),
          },
        ),
      /does not admit workspace version/u,
    );
  }
  assert.throws(
    () =>
      canonicalPublishManifest(
        { peerDependencies },
        {
          catalogVersions: new Map(),
          internalPackageVersions: new Map(),
        },
      ),
    /cannot resolve workspace version/u,
  );
  assert.throws(
    () =>
      canonicalPublishManifest(
        { dependencies: peerDependencies },
        {
          catalogVersions: new Map(),
          internalPackageVersions: new Map([["@fixture/core", "1.9.0"]]),
        },
      ),
    /requires workspace:\*/u,
  );
}

function assertStablePeerUnions(): void {
  const peerDependencies = { "@fixture/core": "workspace:^1.8.0 || ^2.0.0" };
  for (const version of ["1.8.0", "1.10.1", "2.0.0", "2.9.9"]) {
    assert.deepEqual(
      canonicalFixtureManifest(
        { peerDependencies },
        {
          catalogVersions: new Map(),
          internalPackageVersions: new Map([["@fixture/core", version]]),
        },
      )["peerDependencies"],
      { "@fixture/core": "^1.8.0 || ^2.0.0" },
    );
  }
  for (const version of ["1.7.9", "3.0.0", "2.0.0-rc.0"]) {
    assert.throws(
      () =>
        canonicalPublishManifest(
          { peerDependencies },
          {
            catalogVersions: new Map(),
            internalPackageVersions: new Map([["@fixture/core", version]]),
          },
        ),
      /does not admit workspace version/u,
    );
  }
}

function assertUnresolvedAuthorities(): void {
  assert.throws(
    () =>
      canonicalPublishManifest(
        { dependencies: { dependency: "workspace:*" } },
        {
          catalogVersions: new Map(),
          internalPackageVersions: new Map(),
        },
      ),
    /cannot resolve exact workspace version/u,
  );
  assert.throws(
    () =>
      canonicalPublishManifest(
        { dependencies: { dependency: "catalog:" } },
        {
          catalogVersions: new Map(),
          internalPackageVersions: new Map(),
        },
      ),
    /cannot resolve exact catalog version/u,
  );
}

function assertAlternatePublishRoot(): void {
  assert.throws(
    () =>
      canonicalPublishManifest(
        { publishConfig: { directory: "dist" } },
        {
          catalogVersions: new Map(),
          internalPackageVersions: new Map(),
        },
      ),
    /cannot use publishConfig\.directory/u,
  );
}

export function registerManifestAuthorityTests(): void {
  void test("publish manifest canonicalizes exact dependency authorities without reordering other fields", async (t) => {
    const source = {
      name: "@fixture/app",
      exports: { node: "./node.js", default: "./index.js" },
      dependencies: { zed: "2.0.0", "@fixture/core": "workspace:*", ajv: "catalog:" },
      devDependencies: { typescript: "catalog:", alpha: "1.0.0" },
    };
    const canonical = canonicalFixtureManifest(source, {
      catalogVersions: new Map([
        ["ajv", "8.20.0"],
        ["typescript", "7.0.2"],
      ]),
      internalPackageVersions: new Map([["@fixture/core", "1.2.3"]]),
    });
    assert.deepEqual(Object.keys(manifestFixtureRecord(canonical["exports"])), ["node", "default"]);
    assert.deepEqual(canonical["dependencies"], {
      "@fixture/core": "1.2.3",
      ajv: "8.20.0",
      zed: "2.0.0",
    });
    assert.deepEqual(canonical["devDependencies"], { alpha: "1.0.0", typescript: "7.0.2" });
    assert.equal(source.dependencies["@fixture/core"], "workspace:*");

    for (const [specifier, expected] of [
      ["workspace:^", /requires workspace:\*/u],
      ["catalog:parser-oracle", /only supports the default catalog/u],
    ] as const) {
      await t.test(`rejects ${specifier}`, () => {
        assert.throws(
          () =>
            canonicalPublishManifest(
              { dependencies: { dependency: specifier } },
              {
                catalogVersions: new Map(),
                internalPackageVersions: new Map(),
              },
            ),
          expected,
        );
      });
    }
    await t.test(
      "turns an internal peer range into a caret range of the workspace version",
      assertWorkspaceCaretPeers,
    );
    await t.test(
      "retains an explicit stable peer minimum while the workspace advances",
      assertStablePeerMinimum,
    );
    await t.test("retains only validated stable caret union branches", assertStablePeerUnions);
    await t.test("rejects unresolved exact authorities", assertUnresolvedAuthorities);
    await t.test("rejects alternate publish roots", assertAlternatePublishRoot);
  });
}
