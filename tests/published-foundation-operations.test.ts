import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  inspectPublishedFoundationImports,
  publishedFoundationIntegrity,
  withPublishedCompilerFloor,
} from "../scripts/published-foundation-imports.ts";
import { executePublishedFoundationOperation } from "../scripts/published-foundation-operations.ts";
import {
  nodeConsumerIntegrationInputReader,
  nodeManagedGeneration2SourceInputReader,
} from "../packages/docs-protocol-agent-teams/dist/consumer-integration/adapters/node-consumer-integration-repository.js";
import { retainedFixture } from "../packages/docs-protocol-agent-teams/tests/managed-restoration-fixture.ts";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "published-operation-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Synthetic packages below test only rejecting safety boundaries. They never
// supply a positive published compatibility observation or replace its oracle.
async function rejectedInstallation(
  t: TestContext,
  source: string,
): Promise<{ root: string; packageRoot: string; sentinel: string }> {
  const root = await temporary(t);
  const packageRoot = join(root, "node_modules", "@agent-teams", "engineering-foundation");
  await mkdir(join(packageRoot, "dist", "scaffolding"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@agent-teams/engineering-foundation",
      version: "0.12.0",
      type: "module",
      exports: { "./scaffolding": { import: "./dist/scaffolding/index.js" } },
    }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      packages: {
        "node_modules/@agent-teams/engineering-foundation": {
          version: "0.12.0",
          integrity: publishedFoundationIntegrity("0.12.0"),
          resolved:
            "https://registry.npmjs.org/@agent-teams/engineering-foundation/-/engineering-foundation-0.12.0.tgz",
        },
      },
    }),
  );
  const sentinel = join(root, "must-not-evaluate.txt");
  await writeFile(
    join(packageRoot, "dist", "scaffolding", "index.js"),
    `import { writeFileSync } from 'node:fs';\n${source}\nwriteFileSync(${JSON.stringify(sentinel)}, 'evaluated');\n`,
  );
  return { root, packageRoot, sentinel };
}

test("historical operation selection rejects every unadmitted version/operation pair before loading", async () => {
  for (const [version, operation] of [
    ["0.13.0", "plan"],
    ["0.12.0", "attach"],
    ["0.11.0", "plan"],
    ["0.14.0", "check"],
  ]) {
    await assert.rejects(async () => {
      await Reflect.apply(executePublishedFoundationOperation, undefined, [
        { version, operation, packageRoot: "/unreachable", consumerRoot: "/unreachable" },
      ]);
    }, /unsupported historical version\/operation pair/u);
  }
});

test("historical operation compiler preflight rejects static compiler imports before module evaluation", async (t) => {
  const input = await rejectedInstallation(t, "import 'typescript';");
  await assert.rejects(
    executePublishedFoundationOperation({
      packageRoot: input.packageRoot,
      version: "0.12.0",
      consumerRoot: input.root,
      operation: "plan",
      inputPath: "intent.yaml",
    }),
    /compiler\/extractor import is forbidden/u,
  );
  await assert.rejects(readFile(input.sentinel), { code: "ENOENT" });
});

test("historical operation preflight follows CommonJS require edges as data", async (t) => {
  const input = await rejectedInstallation(t, "import './unsafe.cjs';");
  await writeFile(
    join(input.packageRoot, "dist", "scaffolding", "unsafe.cjs"),
    "require('@microsoft/api-extractor');",
  );
  assert.throws(
    () => inspectPublishedFoundationImports(input.packageRoot, "0.12.0", "scaffolding"),
    /compiler\/extractor import is forbidden/u,
  );
  await assert.rejects(readFile(input.sentinel), { code: "ENOENT" });
});

test("historical operation preflight rejects unqualified computed imports", async (t) => {
  const input = await rejectedInstallation(
    t,
    "export function loader(specifier) { return import(specifier); }",
  );
  assert.throws(
    () => inspectPublishedFoundationImports(input.packageRoot, "0.12.0", "scaffolding"),
    /unqualified computed import/u,
  );
  await assert.rejects(readFile(input.sentinel), { code: "ENOENT" });
});

test("historical operation preflight requires the original dormant import module bytes", async (t) => {
  const input = await rejectedInstallation(t, "import '../package-self-check.js';");
  await writeFile(
    join(input.packageRoot, "dist", "package-self-check.js"),
    "export function selfCheck(specifier) { return import(specifier); }",
  );
  assert.throws(
    () => inspectPublishedFoundationImports(input.packageRoot, "0.12.0", "scaffolding"),
    /unqualified computed import/u,
  );
});

test("historical operation preflight retains exact registry integrity and public subpath identity", async (t) => {
  const input = await rejectedInstallation(t, "export {};");
  await writeFile(
    join(input.root, "package-lock.json"),
    JSON.stringify({
      packages: {
        "node_modules/@agent-teams/engineering-foundation": {
          version: "0.12.0",
          integrity: "sha512:changed",
          resolved: "https://registry.npmjs.org/changed.tgz",
        },
      },
    }),
  );
  assert.throws(
    () => inspectPublishedFoundationImports(input.packageRoot, "0.12.0", "scaffolding"),
    /registry provenance differs/u,
  );
  await assert.rejects(readFile(input.sentinel), { code: "ENOENT" });
});

test("historical import preflight refuses a pathname replaced during its descriptor read", async (t) => {
  const input = await rejectedInstallation(t, "export {};");
  const path = join(input.packageRoot, "dist", "scaffolding", "index.js");
  const initial = fs.statSync(path, { bigint: true });
  const read = fs.readSync;
  let replaced = false;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const opened = fs.fstatSync(args[0], { bigint: true });
    if (!replaced && opened.dev === initial.dev && opened.ino === initial.ino) {
      replaced = true;
      fs.renameSync(path, `${path}.original`);
      fs.writeFileSync(path, "export const substituted = true;\n");
    }
    return Reflect.apply(read, fs, args) as number;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => inspectPublishedFoundationImports(input.packageRoot, "0.12.0", "scaffolding"),
      /source file changed during its bounded read/u,
    );
    assert.equal(replaced, true);
  } finally {
    fs.readSync = read;
    syncBuiltinESMExports();
  }
  await assert.rejects(readFile(input.sentinel), { code: "ENOENT" });
});

test("historical barrier preflight rejects nonfiles and symbolic links before loading", async (t) => {
  const root = await temporary(t);
  const path = join(root, ".agent-teams-local", "scaffolding-transaction.json");
  await mkdir(path, { recursive: true });
  const request = {
    packageRoot: root,
    version: "0.14.0",
    consumerRoot: root,
    operation: "status",
  } as const;
  await assert.rejects(
    executePublishedFoundationOperation(request),
    /bounded regular file|EISDIR/u,
  );
  await rm(path, { recursive: true });
  const target = join(root, "outside.json");
  await writeFile(target, '{"schemaVersion":3}');
  await symlink(target, path, "file");
  await assert.rejects(executePublishedFoundationOperation(request), /bounded regular file|ELOOP/u);
});

test("historical mutation scenarios require preserved transaction evidence before loading", async (t) => {
  const root = await temporary(t);
  await assert.rejects(
    executePublishedFoundationOperation({
      packageRoot: root,
      version: "0.11.0",
      consumerRoot: root,
      operation: "recover",
    }),
    { code: "ENOENT" },
  );
  await mkdir(join(root, ".agent-teams-local"));
  await writeFile(
    join(root, ".agent-teams-local", "scaffolding-transaction.json"),
    '{"schemaVersion":2}',
  );
  await assert.rejects(
    executePublishedFoundationOperation({
      packageRoot: root,
      version: "0.14.0",
      consumerRoot: root,
      operation: "status",
    }),
    /outside the named historical barrier scenario/u,
  );
});

test("compiler floor denies ESM and CommonJS compiler evaluation without substituting an implementation", async (t) => {
  const root = await temporary(t);
  const sentinel = join(root, "compiler-evaluated.txt");
  for (const packageName of ["typescript", "@microsoft/api-extractor"]) {
    const directory = join(root, "node_modules", ...packageName.split("/"));
    await mkdir(directory, { recursive: true });
    const esm = join(directory, "compiler.mjs");
    const cjs = join(directory, "compiler.cjs");
    await writeFile(
      esm,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'evaluated');`,
    );
    await writeFile(
      cjs,
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'evaluated');`,
    );
    await assert.rejects(
      withPublishedCompilerFloor(async () => {
        await import(pathToFileURL(esm).href);
      }),
      /compiler floor guard refused/u,
    );
    await assert.rejects(
      withPublishedCompilerFloor(async () => {
        createRequire(import.meta.url)(cjs);
      }),
      /compiler floor guard refused/u,
    );
  }
  await assert.rejects(readFile(sentinel), { code: "ENOENT" });
});

test("a historical catch cannot convert a compiler denial into successful evidence", async (t) => {
  const root = await temporary(t);
  const compiler = join(root, "node_modules", "typescript", "index.mjs");
  await mkdir(join(root, "node_modules", "typescript"), { recursive: true });
  await writeFile(compiler, "throw new Error('module must never evaluate');");
  await assert.rejects(
    withPublishedCompilerFloor(async () => {
      try {
        await import(pathToFileURL(compiler).href);
      } catch {
        return { outcome: "returned", value: "fabricated by caller catch" };
      }
      return;
    }),
    /compiler floor guard refused/u,
  );
});

test("compiler floor refuses a computed root import that reaches a compiler through an alternate package alias", async (t) => {
  const root = await temporary(t);
  const alias = join(root, "node_modules", "compiler-alias");
  const sentinel = join(root, "alias-evaluated.txt");
  await mkdir(alias, { recursive: true });
  await writeFile(
    join(alias, "package.json"),
    '{"name":"typescript","version":"5.9.3","type":"module"}',
  );
  await writeFile(
    join(alias, "index.js"),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'evaluated');`,
  );
  const rootModule = join(root, "root.mjs");
  await writeFile(
    rootModule,
    "import './node_modules/compiler-alias/index.js'; export const result = true;",
  );
  const selfCheck = join(root, "self-check.mjs");
  await writeFile(selfCheck, "export function inspect(specifier) { return import(specifier); }");
  await assert.rejects(
    withPublishedCompilerFloor(async () => {
      const loaded: unknown = await import(pathToFileURL(selfCheck).href);
      assert(
        loaded !== null &&
          typeof loaded === "object" &&
          "inspect" in loaded &&
          typeof loaded.inspect === "function",
      );
      await Reflect.apply(loaded.inspect, loaded, [pathToFileURL(rootModule).href]);
    }),
    /compiler floor guard refused/u,
  );
  await assert.rejects(readFile(sentinel), { code: "ENOENT" });
});

test("compiler floor passes original builtin behavior and releases its guard after failure", async () => {
  assert.equal(
    await withPublishedCompilerFloor(async () => (await import("node:path")).basename("/one/two")),
    "two",
  );
  await assert.rejects(
    withPublishedCompilerFloor(async () => {
      throw new Error("operation failed");
    }),
    /operation failed/u,
  );
  assert.equal(
    await withPublishedCompilerFloor(async () =>
      (await import("node:path")).basename("/three/four"),
    ),
    "four",
  );
});

function retainedSourceChild(
  fixture: Awaited<ReturnType<typeof retainedFixture>>,
  mode: "observe" | "catch-denial",
  compilerAlias: string,
) {
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    killed: boolean;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    execFile(
      process.execPath,
      [
        fileURLToPath(new URL("./retained-source-compiler-floor-child.ts", import.meta.url)),
        mode,
        fixture.root,
        JSON.stringify(fixture.current),
        compilerAlias,
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          signal: error?.signal ?? null,
          killed: error?.killed ?? false,
          stdout,
          stderr,
        });
      },
    ).once("error", reject);
  });
}

test(
  process.platform === "win32"
    ? "guarded retained source observation [Windows runtime refusal]"
    : "retained source observation enforces the compiler floor in its actual child process",
  async (context) => {
    for (const sourceNodePin of ["24.21.0\n", "26.11.1\n", "26.12.1\n"] as const) {
      await context.test(`source pin ${sourceNodePin.trim()}`, async (nested) => {
        const fixture = await retainedFixture(nested, sourceNodePin);
        const sentinel = join(fixture.disposable, "consumer-executable-evaluated.txt");
        // These are rejecting TEST sentinels, not published package substitutes
        // and not a positive registry-installation qualification.
        for (const [name, version] of [
          [
            "@agent-teams/engineering-foundation",
            fixture.current.cohort.packages.engineeringFoundation.version,
          ],
          [
            "@agent-teams/docs-protocol-agent-teams",
            fixture.current.cohort.packages.docsProtocolAgentTeams.version,
          ],
          ["typescript", "5.9.3"],
        ]) {
          assert.ok(name && version);
          const directory = join(fixture.root, "node_modules", ...name.split("/"));
          await mkdir(join(directory, "dist"), { recursive: true });
          await writeFile(
            join(directory, "package.json"),
            JSON.stringify({ name, version, type: "module", exports: "./dist/index.js" }),
          );
          const poison = `${name === "@agent-teams/engineering-foundation" ? "import 'typescript';\n" : ""}import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'unexpected evaluation');\nthrow new Error('TEST_CONSUMER_EXECUTION_FORBIDDEN');\n`;
          await writeFile(join(directory, "dist", "index.js"), poison);
          await writeFile(join(directory, "dist", "cli.js"), poison);
        }
        const aliasDirectory = join(fixture.root, "node_modules", "compiler-alias");
        await mkdir(aliasDirectory, { recursive: true });
        await writeFile(
          join(aliasDirectory, "package.json"),
          '{"name":"typescript","version":"5.9.3","type":"module"}',
        );
        const compilerAlias = join(aliasDirectory, "index.js");
        await writeFile(
          compilerAlias,
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'unexpected alias evaluation'); throw new Error('TEST_COMPILER_ALIAS_EVALUATED');\n`,
        );
        if (process.platform === "win32") {
          assert.equal(process.versions.node.split(".")[0], "26");
          await assert.rejects(
            nodeManagedGeneration2SourceInputReader.read({ consumerRoot: fixture.root }),
            { code: "DOCS_CONSUMER_UNSUPPORTED_NODE" },
          );
          nested.diagnostic(
            "Windows default Node26 refusal only; no positive retained source qualification.",
          );
        } else {
          assert.equal(process.versions.node, "24.22.3");
          const observed = await retainedSourceChild(fixture, "observe", compilerAlias);
          assert.equal(observed.code, 0, JSON.stringify(observed));
          assert.equal(observed.signal, null, JSON.stringify(observed));
          assert.equal(observed.killed, false, JSON.stringify(observed));
          assert.equal(observed.stdout, "TEST_RETAINED_SOURCE_GUARDED_COMPLETE\n");
          assert.equal(observed.stderr, "");
          await assert.rejects(readFile(sentinel), { code: "ENOENT" });

          const refused = await retainedSourceChild(fixture, "catch-denial", compilerAlias);
          assert.equal(refused.code, 86, JSON.stringify(refused));
          assert.equal(refused.signal, null, JSON.stringify(refused));
          assert.equal(refused.killed, false, JSON.stringify(refused));
          assert.equal(refused.stdout, "");
          assert.equal(
            refused.stderr,
            "TEST_RETAINED_SOURCE_COMPILER_DENIAL_CAUGHT\nTEST_RETAINED_SOURCE_STICKY_GUARD_REFUSED\n",
          );
          await assert.rejects(readFile(sentinel), { code: "ENOENT" });
          await withPublishedCompilerFloor(async () => {
            if (sourceNodePin !== "24.21.0\n") {
              await assert.rejects(
                nodeConsumerIntegrationInputReader.read({ consumerRoot: fixture.root }),
                { code: "DOCS_CONSUMER_NODE_VERSION_GATE_INVALID" },
              );
              await assert.rejects(
                Reflect.apply(nodeConsumerIntegrationInputReader.read, undefined, [
                  { consumerRoot: fixture.root },
                  "generation2-source",
                ]),
                { code: "DOCS_CONSUMER_NODE_VERSION_GATE_INVALID" },
              );
            } else {
              assert.deepEqual(
                (await nodeConsumerIntegrationInputReader.read({ consumerRoot: fixture.root }))
                  .desired,
                fixture.current,
              );
            }
          });
        }
        await assert.rejects(readFile(sentinel), { code: "ENOENT" });
        for (const [path, bytes] of fixture.originals) {
          assert.deepEqual(await readFile(join(fixture.root, path)), bytes, path);
        }
        assert.deepEqual(fixture.activation, []);
        await assert.rejects(readFile(fixture.options.proofPath), { code: "ENOENT" });
      });
    }
  },
);
