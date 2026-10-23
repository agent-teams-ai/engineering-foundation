const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const inputFile = (path: string, text: string) => ({
  path,
  digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
});
import { writeFileSync as requireWrite } from "node:fs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32, posix } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ApiPackage } from "@microsoft/api-extractor-model";
import { createRequire } from "node:module";
import { version } from "typescript";

import { MicrosoftPublicApiObserver } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-observer.js";

import { publicApiAuditEligibility } from "../dist/capabilities/public-api-compatibility/application/policies/public-api-audit-eligibility.js";

type ObserverInput = Parameters<MicrosoftPublicApiObserver["observe"]>[0];
async function fixture(
  source: string,
  action: (observer: MicrosoftPublicApiObserver, input: ObserverInput) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-observer-test-"));
  try {
    const files = {
      "package.json": JSON.stringify({
        name: "audit-fixture",
        version: "1.0.0",
        types: "index.d.ts",
        exports: { ".": { types: "./index.d.ts" } },
      }),
      "index.d.ts": source,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          strict: true,
          skipLibCheck: false,
        },
        files: ["index.d.ts"],
      }),
    };
    for (const [path, text] of Object.entries(files)) {
      await writeFile(join(root, path), text);
    }
    const declarations: ObserverInput["declarations"] = {
      packages: [
        {
          packageName: "audit-fixture",
          packageVersion: "1.0.0",
          manifestPath: "package.json",
          tsconfigPath: "tsconfig.json",
          entrypoints: [{ exportPath: ".", declarationEntryPoint: "index.d.ts" }],
          nonTypeExports: [],
        },
      ],
      files: Object.entries(files).map(([path, text]) => ({
        path,
        digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
      })),
      resolutionUniverse: [
        { packageName: "audit-fixture", exportPath: ".", declarationPath: "index.d.ts" },
      ],
    };
    await action(new MicrosoftPublicApiObserver(), {
      consumerRoot: root,
      subject: "A",
      declarations,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("config dependencies are captured; suppressed diagnostics and model-count exhaustion are refused", async () => {
  await fixture("export declare function f(): void;\n", async (observer, input) => {
    const base = JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", skipLibCheck: false },
    });
    const config = JSON.stringify({ extends: "./base.json", files: ["index.d.ts"] });
    await writeFile(join(input.consumerRoot, "base.json"), base);
    await writeFile(join(input.consumerRoot, "tsconfig.json"), config);
    const declarations = {
      ...input.declarations,
      files: [
        ...input.declarations.files.filter((item) => item.path !== "tsconfig.json"),
        inputFile("tsconfig.json", config),
        inputFile("base.json", base),
      ],
    };
    const observations = await observer.observe({ ...input, declarations });
    assert(observations[0]);
    assert.deepEqual(
      observations[0].configurationDependencies.map((item) => item.path).toSorted(),
      ["base.json", "package.json", "tsconfig.json"],
    );
    assert.ok(observations[0].sourceFiles.some((item) => item.path === "index.d.ts"));
    assert.ok(!observations[0].compilerEnvironment.includes("foundation-public-api-audit-"));
    assert.deepEqual(publicApiAuditEligibility(observations), { eligible: true, reasons: [] });
    const suppressed = JSON.stringify({
      compilerOptions: { skipLibCheck: true },
      files: ["index.d.ts"],
    });
    await writeFile(join(input.consumerRoot, "tsconfig.json"), suppressed);
    const invalid = await observer.observe({
      ...input,
      declarations: {
        ...input.declarations,
        files: [
          ...input.declarations.files.filter((item) => item.path !== "tsconfig.json"),
          inputFile("tsconfig.json", suppressed),
        ],
      },
    });
    assert(invalid[0]);
    assert.equal(invalid[0].invocation.outcome, "not-invoked");
    assert.ok(invalid[0].unsupported.some((reason) => reason.includes("suppression")));
    await assert.rejects(
      observer.observe({
        ...input,
        declarations: {
          ...input.declarations,
          packages: [
            {
              ...input.declarations.packages[0]!,
              entrypoints: Array.from({ length: 65 }, (_, i) => ({
                exportPath: `./entry-${i}`,
                declarationEntryPoint: "index.d.ts",
              })),
            },
          ],
        },
      }),
      /64-model/u,
    );
  });
});

test("obsolete compiler options remain real native diagnostics", async () => {
  await fixture("export declare function f(): void;\n", async (observer, input) => {
    const config = JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, baseUrl: "." },
      files: ["index.d.ts"],
    });
    await writeFile(join(input.consumerRoot, "tsconfig.json"), config);
    const observed = await observer.observe({
      ...input,
      declarations: {
        ...input.declarations,
        files: [
          ...input.declarations.files.filter((file) => file.path !== "tsconfig.json"),
          inputFile("tsconfig.json", config),
        ],
      },
    });
    assert(observed[0]);
    assert.equal(observed[0].compilerDiagnosticsCollected, true);
    assert.ok(
      observed[0].diagnostics.some(
        (diagnostic) =>
          diagnostic.source === "compiler" &&
          diagnostic.id === "TS5102" &&
          diagnostic.severity === "error",
      ),
    );
    assert.equal(observed[0].invocation.outcome, "exception");
    assert.equal(observed[0].modelPresent, false);
    assert.equal(publicApiAuditEligibility(observed).eligible, false);
  });
});

test("undeclared nested resolution metadata cannot change admission behind identical digests", async () => {
  await fixture('export { f } from "./sub/entry.js";\n', async (observer, input) => {
    const root = input.consumerRoot;
    await mkdir(join(root, "sub"));
    const files = {
      "package.json": JSON.stringify({
        name: "audit-fixture",
        version: "1.0.0",
        type: "module",
        types: "index.d.ts",
        exports: { ".": { types: "./index.d.ts" } },
      }),
      "sub/entry.d.ts": 'import type { T } from "./types"; export declare function f(): T;\n',
      "sub/types.d.ts": "export type T = string;\n",
    };
    for (const [path, text] of Object.entries(files)) {
      await writeFile(join(root, path), text);
    }
    const declarations = {
      ...input.declarations,
      files: [
        ...input.declarations.files.filter((file) => file.path !== "package.json"),
        ...Object.entries(files).map(([path, text]) => ({ path, digest: digest(text) })),
      ],
    };
    for (const type of ["commonjs", "module"]) {
      await writeFile(join(root, "sub/package.json"), JSON.stringify({ type }));
      const observations = await observer.observe({ ...input, declarations });
      assert(observations[0]);
      assert.equal(publicApiAuditEligibility(observations).eligible, false);
      assert.equal(observations[0].inputBytesRevalidated, false);
      assert.equal(observations[0].invocation.outcome, "not-invoked");
      assert.ok(
        observations[0].unsupported.some((reason) => reason.includes("resolution metadata")),
      );
    }
    const metadata = JSON.stringify({ type: "commonjs" });
    await writeFile(join(root, "sub/package.json"), metadata);
    declarations.files.push({ path: "sub/package.json", digest: digest(metadata) });
    const admitted = await observer.observe({ ...input, declarations });
    assert(admitted[0]);
    assert.equal(publicApiAuditEligibility(admitted).eligible, true, JSON.stringify(admitted));
    assert.ok(
      admitted[0].configurationDependencies.some(
        (file) => file.path === "sub/package.json" && file.digest === digest(metadata),
      ),
    );
    const originalSave = ApiPackage.prototype.saveToJsonFile;
    ApiPackage.prototype.saveToJsonFile = function (...args) {
      // Mutation after compiler creation must invalidate custody even if extraction completes.
      const result = originalSave.apply(this, args);
      requireWrite(join(root, "sub/package.json"), JSON.stringify({ type: "module" }));
      return result;
    };
    try {
      const changed = await observer.observe({ ...input, declarations });
      assert(changed[0]);
      assert.equal(changed[0].inputBytesRevalidated, false);
      assert.equal(publicApiAuditEligibility(changed).eligible, false);
      assert.ok(
        changed[0].unsupported.some((reason) => reason.includes("changed during observation")),
      );
    } finally {
      ApiPackage.prototype.saveToJsonFile = originalSave;
    }
  });
});

test("enclosing manifest outside the supplied root is an explicit unsupported boundary", async () => {
  await fixture("export declare function f(): void;\n", async (observer, input) => {
    const nested = join(input.consumerRoot, "nested");
    await mkdir(nested);
    for (const file of input.declarations.files) {
      await writeFile(join(nested, file.path), await readFile(join(input.consumerRoot, file.path)));
    }
    const observations = await observer.observe({ ...input, consumerRoot: nested });
    assert(observations[0]);
    assert.equal(publicApiAuditEligibility(observations).eligible, false);
    assert.equal(observations[0].inputBytesRevalidated, false);
    const enclosingManifest = join(await realpath(input.consumerRoot), "package.json");
    assert.ok(
      observations[0].unsupported.some((reason) =>
        reason.includes(`resolution metadata: ${enclosingManifest}`),
      ),
    );
  });
});

test("audit proves its exact native SDK and refuses an incompatible model manifest", async () => {
  const sdk =
    await import("../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/load-pinned-audit-sdk.js");
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(require.resolve("typescript/package.json"));
  const nativeManifestPath = nativeRequire.resolve(
    `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
  );
  const nativeManifest = JSON.parse(await readFile(nativeManifestPath, "utf8")) as {
    version: string;
  };
  assert.equal(version, "7.0.2");
  assert.equal(nativeManifest.version, "7.0.2");
  assert.equal(
    sdk.nativeCompilerPath,
    join(dirname(nativeManifestPath), "lib", process.platform === "win32" ? "tsc.exe" : "tsc"),
  );
  sdk.assertPinnedAuditSdk();
  const identity = JSON.parse(sdk.auditToolchainIdentity()) as {
    extractor: string;
    compiler: string;
    model: string;
  };
  assert.deepEqual(
    [identity.extractor, identity.compiler, identity.model],
    ["typescript-native/7.0.2", "7.0.2", "7.33.10"],
  );
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-wrong-model-"));
  try {
    const actual = new URL(
      "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/",
      import.meta.url,
    );
    await mkdir(join(root, "adapter"));
    await mkdir(join(root, "node_modules", "@microsoft", "api-extractor-model", "lib-commonjs"), {
      recursive: true,
    });
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      join(root, "adapter", "load-pinned-audit-sdk.js"),
      await readFile(new URL("load-pinned-audit-sdk.js", actual)),
    );
    await symlink(
      dirname(require.resolve("typescript/package.json")),
      join(root, "node_modules", "typescript"),
      "junction",
    );
    await writeFile(
      join(root, "node_modules", "@microsoft", "api-extractor-model", "package.json"),
      JSON.stringify({
        name: "@microsoft/api-extractor-model",
        version: "0.0.0",
        main: "lib-commonjs/index.js",
      }),
    );
    await writeFile(
      join(root, "node_modules", "@microsoft", "api-extractor-model", "lib-commonjs", "index.js"),
      "",
    );
    await writeFile(
      join(root, "check-model.ts"),
      'import { assertPinnedAuditSdk } from "./adapter/load-pinned-audit-sdk.js"; assertPinnedAuditSdk();\n',
    );
    const rejected = spawnSync(process.execPath, ["check-model.ts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    assert.equal(rejected.error, undefined);
    assert.equal(rejected.signal, null);
    assert.equal(rejected.status, 1);
    assert.match(
      rejected.stderr,
      /Unsupported audit toolchain: require native TypeScript 7\.0\.2 and API Extractor Model 7\.33\.10/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observer canonicalizes a symlinked root ancestor without admitting symlinked inputs", async () => {
  await fixture("export declare function f(): void;\n", async (observer, input) => {
    const aliases = await mkdtemp(join(tmpdir(), "foundation-audit-root-alias-"));
    try {
      await symlink(await realpath(input.consumerRoot), join(aliases, "root"), "dir");
      const aliased = { ...input, consumerRoot: join(aliases, "root") };
      const observed = await observer.observe(aliased);
      assert(observed[0]);
      assert.equal(publicApiAuditEligibility(observed).eligible, true);
      assert.equal(observed[0].inputBytesRevalidated, true);
      await symlink(join(aliases, "outside.d.ts"), join(input.consumerRoot, "linked.d.ts"));
      await writeFile(join(aliases, "outside.d.ts"), "export declare const outside: true;\n");
      await assert.rejects(
        observer.observe({
          ...aliased,
          declarations: {
            ...input.declarations,
            files: [
              ...input.declarations.files,
              inputFile("linked.d.ts", "export declare const outside: true;\n"),
            ],
          },
        }),
        /Audit symlink unsupported/,
      );
      await assert.rejects(
        observer.observe({
          ...aliased,
          declarations: { ...input.declarations, files: [inputFile("../outside.d.ts", "")] },
        }),
        /Invalid audit path/,
      );
    } finally {
      await rm(aliases, { recursive: true, force: true });
    }
  });
});

test("audit stage remapping handles Windows SDK paths without capturing outside evidence", async () => {
  const { remapAuditStagePath } =
    await import("../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-audit-inputs.js");
  const stage = String.raw`C:\temp\audit\evidence`;
  const root = String.raw`D:\consumer`;
  for (const path of [
    String.raw`C:\temp\audit\evidence\sub\index.d.ts`,
    "C:/temp/audit/evidence/sub/index.d.ts",
    "c:/temp/audit/evidence/sub/index.d.ts",
  ]) {
    assert.equal(
      remapAuditStagePath(path, stage, root, win32),
      String.raw`D:\consumer\sub\index.d.ts`,
    );
  }
  for (const path of [
    "C:/temp/audit/evidence-other/index.d.ts",
    "C:/temp/audit/evidence/../outside.d.ts",
    "C:/temp/audit",
    "E:/temp/audit/evidence/index.d.ts",
    "//server/share/index.d.ts",
    "relative/index.d.ts",
  ]) {
    assert.equal(remapAuditStagePath(path, stage, root, win32), path);
  }
  assert.equal(
    remapAuditStagePath(
      "//server/share/stage/sub/file",
      String.raw`\\server\share\stage`,
      root,
      win32,
    ),
    String.raw`D:\consumer\sub\file`,
  );
  assert.equal(
    remapAuditStagePath("/stage/sub/file", "/stage", "/consumer", posix),
    "/consumer/sub/file",
  );
  assert.equal(
    remapAuditStagePath("/stage-other/file", "/stage", "/consumer", posix),
    "/stage-other/file",
  );
});

test("audit portable input paths reject Windows absolutes and drive-relative escapes on every host", async () => {
  const { auditInputPath } =
    await import("../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/public-api-audit-inputs.js");
  for (const path of [
    "C:/temp/input.json",
    "C:input.json",
    "sub/C:input.json",
    String.raw`C:\temp\input.json`,
    "//server/share/input.json",
    "../input.json",
    "sub/../../input.json",
  ]) {
    await assert.rejects(auditInputPath("/unused", path), /Invalid audit path/);
  }
});

test("observer serializes native canonical temp inputs relative to the request root", async () => {
  await fixture("export declare function f(): void;\n", async (observer, input) => {
    // On Windows tmpdir may contain RUNNER~1 while native realpath expands it.
    // A separate alias also exercises root canonicalization on POSIX hosts.
    const aliases = await mkdtemp(join(tmpdir(), "foundation-audit-root-alias-"));
    try {
      const alias = join(aliases, "request");
      await symlink(await realpath(input.consumerRoot), alias, "junction");
      for (const consumerRoot of [input.consumerRoot, alias]) {
        const [observation] = await observer.observe({ ...input, consumerRoot });
        assert(observation);
        assert.deepEqual(observation.unsupported, []);
        assert.equal(observation.inputBytesRevalidated, true);
        assert.deepEqual(
          observation.configurationDependencies.map((file) => file.path).toSorted(),
          ["package.json", "tsconfig.json"],
        );
        assert.ok(observation.sourceFiles.some((file) => file.path === "index.d.ts"));
        assert.equal(publicApiAuditEligibility([observation]).eligible, true);
      }
    } finally {
      await rm(aliases, { recursive: true, force: true });
    }
  });
});
