import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { observeSourceGraph } from "../packages/engineering-foundation/dist/source-graph.js";
import { checkFeatureModuleOnDisk } from "../packages/feature-module-standard/dist/node.js";
import { CapabilityInputError } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import { FilesystemSourceTreeReader } from "../packages/engineering-foundation/dist/source-inventory/adapters/outbound/filesystem/filesystem-source-tree-reader.js";

async function fixture(t: TestContext, paths: readonly string[]): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-source-observation-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "export const value = 1;\n");
  }
  return root;
}

function hasProblem(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CapabilityInputError && error.problem.code === code;
}

void test(
  "public graph and FMS reject a physical source name that would change its repository identity",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await fixture(t, ["src/a\\b.ts"]);
    await assert.rejects(
      observeSourceGraph({ consumerRoot: root, roots: ["src"] }),
      hasProblem("CONFIG_PATH_INVALID"),
    );
    await assert.rejects(
      checkFeatureModuleOnDisk({
        consumerRoot: root,
        sourceRoots: ["src"],
        structure: {
          featureRoots: ["src"],
          roleRoots: [{ root: "src", role: "application" }],
        },
      }),
      hasProblem("CONFIG_PATH_INVALID"),
    );
  },
);

void test("source cancellation during the final file read cannot return a successful snapshot", async (t) => {
  const root = await fixture(t, ["src/value.ts"]);
  const controller = new AbortController();
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === join(root, "src/value.ts")) {
      controller.abort();
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      new FilesystemSourceTreeReader().read(root, ["src"], controller.signal),
      hasProblem("EXECUTION_CANCELLED"),
    );
    assert.equal(controller.signal.aborted, true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

void test("source cancellation while opening the last empty directory cannot become success", async (t) => {
  const root = await fixture(t, []);
  const controller = new AbortController();
  const originalOpenDirectory = fs.opendir;
  t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    const directory = await originalOpenDirectory(...args);
    controller.abort();
    return directory;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      new FilesystemSourceTreeReader().read(root, ["src"], controller.signal),
      hasProblem("EXECUTION_CANCELLED"),
    );
    assert.equal(controller.signal.aborted, true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

void test("overlapping governed roots observe each physical directory once", async (t) => {
  const root = await fixture(t, ["src/value.ts", "src/nested/value.ts"]);
  const visits = new Map<string, number>();
  const originalOpenDirectory = fs.opendir;
  t.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    const path = String(args[0]);
    visits.set(path, (visits.get(path) ?? 0) + 1);
    return originalOpenDirectory(...args);
  });
  syncBuiltinESMExports();
  try {
    const files = await new FilesystemSourceTreeReader().read(root, ["src/nested", "src", "src"]);
    assert.deepEqual(
      files.map((file) => file.path),
      ["src/nested/value.ts", "src/value.ts"],
    );
    assert.deepEqual([...visits.values()], [1, 1]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

void test("generic source selection retains nested output names, Unicode and directory-root semantics", async (t) => {
  const selected = ["src/coverage/value.ts", "src/dist/value.ts", "src/Ω.ts"];
  const root = await fixture(t, [
    ...selected,
    "src/node_modules/dependency.ts",
    "src/.git/metadata.ts",
    "src/ignored.txt",
  ]);
  const graph = await observeSourceGraph({ consumerRoot: root, roots: ["src"] });
  assert.deepEqual(graph.files, selected);
  await assert.rejects(
    new FilesystemSourceTreeReader().read(root, ["."]),
    hasProblem("CONFIG_PATH_INVALID"),
  );
  await assert.rejects(
    new FilesystemSourceTreeReader().read(root, ["src/Ω.ts"]),
    hasProblem("SOURCE_DIRECTORY_INVALID"),
  );
});
