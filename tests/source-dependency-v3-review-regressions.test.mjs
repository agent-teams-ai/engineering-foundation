import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sourceTopologyAdapters } from "./support/capability-adapters.mjs";
import {
  createWorkspaceInventoryReader, foundationPackageRoot, withTemporaryDirectory,
} from "./helpers/source-dependency-v2-fixture.mjs";

const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(foundationPackageRoot, "dist");
const nodeAdapter = (name) => import(pathToFileURL(join(distRoot,
  `capabilities/source-dependencies/adapters/outbound/node/${name}.js`)).href);
const { PnpmSourceWorkspaceTopologyInspector } = await nodeAdapter("pnpm-source-workspace-topology-inspector");
const { generatedOutputFilesystemIsSafe } = await nodeAdapter("generated-output-filesystem");
const { GeneratedOutputManifestObservations } = await nodeAdapter("generated-output-manifest-observations");

function inspector(limits) {
  return new PnpmSourceWorkspaceTopologyInspector({
    inventoryReader: createWorkspaceInventoryReader(), ...sourceTopologyAdapters(), limits,
  });
}

for (const [budget, source, code] of [
  [19, "", undefined], [18, "", undefined], [17, "", "WORKSPACE_LIMIT_EXCEEDED"],
  [19, "x", undefined], [18, "x", "SOURCE_TOTAL_BYTES_EXCEEDED"],
  [19, "xx", "SOURCE_TOTAL_BYTES_EXCEEDED"],
]) {
  test(`v3 manifest plus source bytes: budget ${budget}, source ${source.length}`, async () => {
    await withTemporaryDirectory(async (root) => {
      fs.writeFileSync(join(root, "package.json"), '{"name":"fixture"}');
      fs.writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
      fs.mkdirSync(join(root, "scripts"));
      fs.writeFileSync(join(root, "scripts/check.ts"), source);
      assert.equal(fs.statSync(join(root, "package.json")).size, 18);
      const inspect = () => inspector({ maxTotalSourceBytes: budget }).inspect({
        consumerRoot: root, workspaceManifestPath: "pnpm-workspace.yaml", packageRoots: [],
        governedRoots: ["scripts"], boundaryRoots: [{ boundaryId: "root", path: "scripts" }],
        v3: { includeRootPackage: true },
      });
      if (code === undefined) {
        assert.deepEqual((await inspect()).sourceFiles, [{ path: "scripts/check.ts", source }]);
      } else {
        await assert.rejects(inspect, (error) => error?.problem?.code === code);
      }
    });
  });
}

test("public discovery limits remain positive safe integers", () => {
  for (const maxTotalSourceBytes of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => inspector({ maxTotalSourceBytes }), TypeError);
  }
});

function outputFixture(root, marker = '{"type":"module"}') {
  // Canonicalize the temporary root for platforms where tmpdir itself is an alias.
  const canonical = fs.realpathSync(root);
  const owner = join(canonical, "owner");
  const outside = join(canonical, "outside");
  for (const directory of [join(owner, "dist"), outside]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(join(directory, "package.json"), marker);
    fs.writeFileSync(join(directory, "check.js"), "export {};\n");
  }
  return { owner, outside, marker: join(owner, "dist/package.json"), input: {
    consumerRoot: owner, packageRoot: ".", target: "dist/check.js", enforceManifestFences: true,
  } };
}

function withFsSeam(overrides, callback) {
  const originals = Object.fromEntries(Object.keys(overrides).map((name) => [name, fs[name]]));
  Object.assign(fs, overrides);
  syncBuiltinESMExports();
  try { return callback(); } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}

for (const seam of ["lstatSync", "openSync"]) {
  test(`v3 marker ancestor swap at ${seam} refuses before any outside descriptor read`, async (context) => {
    await withTemporaryDirectory((root) => {
      const fixture = outputFixture(root);
      const outsideMetadata = fs.statSync(join(fixture.outside, "package.json"));
      const original = fs[seam];
      const read = fs.readSync;
      let switched = false;
      const reads = [];
      const observeRead = (descriptor, ...args) => {
        const metadata = fs.fstatSync(descriptor);
        reads.push({ outside: metadata.dev === outsideMetadata.dev && metadata.ino === outsideMetadata.ino,
          ...(process.platform === "linux" ? { path: fs.readlinkSync(`/proc/self/fd/${descriptor}`) } : {}),
        });
        return read(descriptor, ...args);
      };
      withFsSeam({ readSync: observeRead }, () => {
        assert.equal(generatedOutputFilesystemIsSafe(fixture.input), true);
      });
      assert.ok(reads.length > 0, "stable control must actually read a marker descriptor");
      assert.ok(reads.every(({ outside }) => !outside));
      reads.length = 0;
      withFsSeam({
        [seam](path, ...args) {
          if (!switched && path === fixture.marker) {
            switched = true;
            fs.renameSync(join(fixture.owner, "dist"), join(fixture.owner, "saved-dist"));
            fs.symlinkSync(fixture.outside, join(fixture.owner, "dist"), process.platform === "win32" ? "junction" : "dir");
          }
          return original(path, ...args);
        },
        readSync: observeRead,
      }, () => assert.equal(generatedOutputFilesystemIsSafe(fixture.input), false));
      assert.equal(switched, true);
      assert.deepEqual(reads, [], "no bytes may be consumed after the injected ancestor substitution");
      context.diagnostic(JSON.stringify({ seam, switched, reads, outsideRead: false }));
    });
  });
}

for (const mutation of ["bytes", "identity", "remove", "authority"]) {
  test(`v3 marker revalidation refuses changed ${mutation}`, async () => {
    await withTemporaryDirectory((root) => {
      const fixture = outputFixture(root);
      const observations = new GeneratedOutputManifestObservations(fixture.owner);
      assert.equal(observations.observe(join(fixture.owner, "dist")), true);
      assert.equal(observations.stable(), true);
      if (mutation === "identity") {
        fs.renameSync(fixture.marker, `${fixture.marker}.saved`);
        fs.writeFileSync(fixture.marker, '{"type":"module"}');
      } else if (mutation === "remove") {
        fs.unlinkSync(fixture.marker);
      } else {
        fs.writeFileSync(fixture.marker, mutation === "bytes" ? '{ "type":"module"}' : '{"type":"module","dependencies":{}}');
      }
      assert.equal(observations.stable(), false);
    });
  });
}

for (const extra of [0, 1]) {
  test(`v3 marker per-file byte limit ${extra === 0 ? "equality" : "overflow"}`, async () => {
    await withTemporaryDirectory((root) => {
      const marker = '{"type":"module"}'.padEnd(2 * 1024 * 1024 + extra, " ");
      const fixture = outputFixture(root, marker);
      assert.equal(generatedOutputFilesystemIsSafe(fixture.input), extra === 0);
    });
  });
}

test("v3 marker observations retain the count limit", async () => {
  await withTemporaryDirectory((root) => {
    const fixture = outputFixture(root);
    fs.unlinkSync(fixture.marker);
    const observations = new GeneratedOutputManifestObservations(fixture.owner);
    for (let index = 0; index < 5_000; index += 1) {
      assert.equal(observations.observe(join(fixture.owner, "dist")), true);
    }
    assert.equal(observations.observe(join(fixture.owner, "dist")), false);
  });
});

test("v3 marker unexpected internal errors propagate", async () => {
  await withTemporaryDirectory((root) => {
    const fixture = outputFixture(root);
    const failure = new TypeError("injected internal failure");
    withFsSeam({ readSync() { throw failure; } }, () => {
      assert.throws(() => generatedOutputFilesystemIsSafe(fixture.input), (error) => error === failure);
    });
  });
});

test("v3 marker changes during a read remain rejected", async () => {
  await withTemporaryDirectory((root) => {
    const fixture = outputFixture(root);
    const read = fs.readSync;
    let changed = false;
    withFsSeam({ readSync(descriptor, ...args) {
      const count = read(descriptor, ...args);
      if (!changed) {
        changed = true;
        fs.renameSync(fixture.marker, `${fixture.marker}.saved`);
        fs.writeFileSync(fixture.marker, '{"type":"module"}');
      }
      return count;
    } }, () => assert.equal(generatedOutputFilesystemIsSafe(fixture.input), false));
    assert.equal(changed, true);
  });
});

test("legacy generated output keeps marker fences opt-in", async () => {
  await withTemporaryDirectory((root) => {
    const fixture = outputFixture(root, '{"name":"nested-package"}');
    assert.equal(generatedOutputFilesystemIsSafe(fixture.input), false);
    const { enforceManifestFences: _enforceManifestFences, ...legacy } = fixture.input;
    assert.equal(generatedOutputFilesystemIsSafe(legacy), true);
    assert.equal(generatedOutputFilesystemIsSafe({ ...legacy, enforceManifestFences: false }), true);
  });
});
