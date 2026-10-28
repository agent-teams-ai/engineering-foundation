import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createLiteralFormatter } from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/format-toolchain.js";
import { readContainedRegularFile } from "../../../packages/engineering-foundation/dist/source-inventory/node.js";
import {
  checkFormatCoverage,
  type FormatCoveragePorts,
} from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
import { createFormatObservations } from "../../../packages/engineering-foundation/dist/features/quality-coverage/node.js";
import { createSourceCensusReader } from "../../../packages/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import { loadStrictYamlFile } from "../../../packages/engineering-foundation/dist/features/configuration-input/node.js";
import { loadQualityGatePolicy } from "../../../packages/engineering-foundation/dist/capabilities/quality-gate-runner/module.js";
import { assertSchema } from "../../../packages/engineering-foundation/dist/schema-catalog.js";

async function fixture(t: TestContext, mutation = "", marker = "1", version = "9.0.0") {
  const parent = await mkdtemp(join(tmpdir(), "literal-admission-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "consumer");
  const packageRoot = join(root, "node_modules/stack-toolchain");
  const put = async (path: string, bytes: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  };
  await put(
    "package.json",
    JSON.stringify({
      devDependencies: { "stack-toolchain": version },
      scripts: {
        "format:check": "agent-teams-foundation quality format --consumer .",
        check: "pnpm format:check",
        retained: "node scripts/retained.ts",
      },
    }),
  );
  await put(
    "node_modules/stack-toolchain/package.json",
    JSON.stringify({
      name: "stack-toolchain",
      version,
      type: "module",
      exports: {
        ".": { types: "./index.d.ts", import: "./index.js" },
        "./package.json": "./package.json",
        "./toolchain-manifest.json": "./metadata/pins.json",
      },
      dependencies: { oxfmt: "9.1.0" },
    }),
  );
  await put(
    "node_modules/stack-toolchain/metadata/pins.json",
    '{"schemaVersion":1,"oxfmt":"9.1.0"}',
  );
  // Synthetic public-contract fixture, not an installed formatter/artifact qualification.
  await put(
    "node_modules/stack-toolchain/index.js",
    `import {createHash} from 'node:crypto';
export const formatFilesContractVersion=${marker};
export async function runCommand(input) {
 const files=[...input.formatFiles].sort();
 const hash=createHash('sha256').update(JSON.stringify(files)).digest('hex');
 const details={schemaVersion:1,requested:files,validated:files,attempted:files,digests:{requested:hash,validated:hash,attempted:hash},batches:[{files,completed:true,result:{exitCode:0}}],completed:true,sourceBytesUnchanged:true};
 ${mutation}
 return {command:'format:check',status:'passed',exitCode:0,details};
}`,
  );
  await put("a.json", "{}\n");
  return {
    root,
    parent,
    packageRoot,
    put,
    prepare: () => createLiteralFormatter(readContainedRegularFile)(root),
  };
}

export function registerFormatAdmissionCases(): void {
  registerLiteralAdmissionCases();
  registerAuthorityAdmissionCases();
}

function registerLiteralAdmissionCases(): void {
  void test("literal adapter binds the root pin and public relocated exports without a release-version copy", async (t) => {
    for (const version of ["9.0.0", "10.0.0"]) {
      const f = await fixture(t, "", "1", version);
      const run = await f.prepare();
      await run(["a.json"], new AbortController().signal, 1000);
    }
  });

  void test("old/unknown literal marker refuses before invoking the public command", async (t) => {
    for (const marker of ["undefined", "0", "2", "'1'"]) {
      const f = await fixture(
        t,
        "throw new Error('INVOKED');",
        marker,
        marker === "undefined" ? "0.1.1" : "9.0.0",
      );
      await assert.rejects(f.prepare(), /lacks public literal format contract1/u);
    }
  });

  void test("forged set/digest/batch/completion/source-byte evidence cannot pass admission", async (t) => {
    for (const mutation of [
      "details.requested=['other.json'];",
      "details.requested={toJSON(){return ['a.json'];}};",
      "details.validated=[];",
      "details.attempted=[];",
      "details.digests.attempted='0'.repeat(64);",
      "details.completed=false;",
      "details.sourceBytesUnchanged=false;",
      "details.schemaVersion=2;",
      "details.batches=[];",
      "details.batches[0].completed=false;",
      "details.batches[0].result.exitCode=1;",
      "details.batches[0].files=[];",
      "details.batches[0].files=['a.json','a.json'];",
      "details.failure='TOOLCHAIN_FORMAT_FILE';",
      "details.retainedControlDirectory='outside';",
    ]) {
      const f = await fixture(t, mutation);
      const run = await f.prepare();
      await assert.rejects(
        run(["a.json"], new AbortController().signal, 1000),
        /Stack literal|Literal|Missing literal/u,
      );
    }
  });

  void test("public formatter receives a frozen copy and cannot redefine the caller's expected set", async (t) => {
    const f = await fixture(t, "input.formatFiles.pop();");
    const files = ["a.json"];
    const run = await f.prepare();
    await assert.rejects(run(files, new AbortController().signal, 1000), TypeError);
    assert.deepEqual(files, ["a.json"]);
  });

  void test("ambiguous pins, ranges, aliases, prereleases and wrong package metadata reject", async (t) => {
    for (const patch of [
      { devDependencies: { "stack-toolchain": "^9.0.0" } },
      { devDependencies: { "stack-toolchain": "9.0.0-next.1" } },
      { devDependencies: { "stack-toolchain": "npm:other@9.0.0" } },
      { devDependencies: { "stack-toolchain": "9.0.0", alias: "npm:stack-toolchain@9.0.0" } },
      {
        devDependencies: { "stack-toolchain": "9.0.0" },
        peerDependencies: { "stack-toolchain": "9.0.0" },
      },
    ]) {
      const f = await fixture(t);
      await f.put("package.json", JSON.stringify(patch));
      await assert.rejects(f.prepare(), /stack-toolchain/u);
    }
    for (const metadata of [
      { name: "wrong", version: "9.0.0" },
      { name: "stack-toolchain", version: "8.0.0" },
    ]) {
      const f = await fixture(t);
      await f.put("node_modules/stack-toolchain/package.json", JSON.stringify(metadata));
      await assert.rejects(f.prepare(), /installed identity/u);
    }
    const malformed = await fixture(t);
    await malformed.put(
      "node_modules/stack-toolchain/metadata/pins.json",
      '{"schemaVersion":2,"oxfmt":"9.1.0"}',
    );
    await assert.rejects(malformed.prepare(), /version manifest/u);
  });

  void test("borrowed node_modules, ancestor packages and cross-package export symlinks refuse", async (t) => {
    const whole = await fixture(t);
    const external = join(whole.parent, "external");
    await rename(join(whole.root, "node_modules"), external);
    await symlink(external, join(whole.root, "node_modules"), "dir");
    await assert.rejects(whole.prepare());
    const exportEscape = await fixture(t);
    await exportEscape.put(
      "node_modules/other/entry.js",
      "export const formatFilesContractVersion=1;",
    );
    await rm(join(exportEscape.packageRoot, "index.js"));
    await symlink(
      join(exportEscape.root, "node_modules/other/entry.js"),
      join(exportEscape.packageRoot, "index.js"),
    );
    await assert.rejects(exportEscape.prepare(), /exports escape/u);
    const ancestor = await fixture(t);
    await mkdir(join(ancestor.root, "child"));
    await writeFile(
      join(ancestor.root, "child/package.json"),
      '{"devDependencies":{"stack-toolchain":"9.0.0"}}',
    );
    await assert.rejects(
      createLiteralFormatter(readContainedRegularFile)(join(ancestor.root, "child")),
      /outside consumer node_modules/u,
    );
  });
}

function registerAuthorityAdmissionCases(): void {
  void test("static mode has no authority execution port; full mode binds one original budget and rejects authority failure", async () => {
    let now = 0;
    const events: string[] = [];
    const observed = {
      paths: ["a.json", "records/a.json"],
      fingerprints: new Map<string, string>(),
      budgetMs: 100,
      authorities: ["retained"],
      gate: { configPath: "gates.yaml", profileId: "format" },
      selection: {
        maintainedRoots: ["records"],
        routes: [{ authority: "retained", files: ["records/a.json"], trees: [] }],
      },
    };
    const ports: FormatCoveragePorts = {
      nowMs: () => now,
      read: async () => {
        now += 20;
        return observed;
      },
      verify: async () => {
        events.push("verify");
      },
      prepareFormatter: async () => {
        now += 20;
        return async (_files, _signal, budgetMs) => {
          events.push(`literal:${budgetMs}`);
          now += 20;
        };
      },
    };
    const input = { consumerRoot: "/fixture", configPath: "format.yaml", scopeOnly: true };
    const scope = await checkFormatCoverage(input, ports);
    assert.equal(scope.outcome, "passed");
    assert.equal(scope.diagnostics[0]?.subject, "static-scope");
    assert.deepEqual(events, ["verify"]);
    now = 0;
    events.length = 0;
    const full = await checkFormatCoverage(
      { ...input, scopeOnly: false },
      {
        ...ports,
        execution: {
          qualityGateActive: false,
          runAuthorities: async (_input, _observed, budgetMs) => {
            events.push(`authority:${budgetMs}`);
          },
        },
      },
    );
    assert.equal(full.outcome, "passed");
    assert.deepEqual(events, ["verify", "literal:60", "verify", "authority:40", "verify"]);
    now = 0;
    const denied = await checkFormatCoverage(
      { ...input, scopeOnly: false },
      {
        ...ports,
        execution: {
          qualityGateActive: false,
          runAuthorities: async () => {
            throw new Error("authority refused");
          },
        },
      },
    );
    assert.notEqual(denied.outcome, "passed");
    now = 0;
    events.length = 0;
    assert.notEqual(
      (
        await checkFormatCoverage(
          { ...input, scopeOnly: false },
          {
            ...ports,
            execution: {
              qualityGateActive: true,
              runAuthorities: async () => assert.fail("nested authority"),
            },
          },
        )
      ).outcome,
      "passed",
    );
    assert.deepEqual(events, []);
  });

  void test("additive root schema admission preserves old consumers and rejects unknown capabilities/versions", async () => {
    for (const version of [1, 2, 3]) {
      await assertSchema(
        version === 1
          ? "foundation-config/v1"
          : version === 2
            ? "foundation-config/v2"
            : "foundation-config/v3",
        {
          schemaVersion: version,
          project: { id: "fixture" },
          capabilities: { "workspace.dependency-declarations": { configPath: "policy.yaml" } },
        },
        "fixture",
      );
    }
    const input = {
      project: { id: "fixture" },
      capabilities: { "quality.format-coverage": { configPath: "format.yaml" } },
    };
    await assertSchema("foundation-config/v3", { ...input, schemaVersion: 3 }, "fixture");
    for (const id of ["foundation-config/v1", "foundation-config/v2"] as const) {
      await assert.rejects(
        assertSchema(id, { ...input, schemaVersion: id.endsWith("v1") ? 1 : 2 }, "fixture"),
      );
    }
    await assert.rejects(
      assertSchema("foundation-config/v3", { ...input, schemaVersion: 4 }, "fixture"),
    );
    await assert.rejects(
      assertSchema(
        "foundation-config/v3",
        { ...input, schemaVersion: 3, capabilities: { unknown: { configPath: "format.yaml" } } },
        "fixture",
      ),
    );
  });

  void test("real observation requires the exact readonly authority chain and preserves full metadata byte custody", async (t) => {
    const f = await fixture(t);
    await f.put(
      "scripts/retained.ts",
      "throw new Error('fixture validator is not executed by static observation');",
    );
    await f.put("records/a.json", "{}\n");
    const profile = {
      schemaVersion: 1,
      owner: "tooling",
      budgetMs: 10000,
      maintainedRoots: ["scripts", "records"],
      rootFiles: "format-or-reject",
      scripts: { format: "format:check", required: ["check"] },
      authorities: [
        {
          id: "history",
          owner: "history",
          script: "retained",
          execution: "read-only-source-validation",
        },
      ],
      routes: [{ authority: "history", kind: "retained", files: ["records/a.json"], trees: [] }],
      alternates: { configPath: "gates.yaml", profileId: "format" },
    };
    await f.put("format.yaml", JSON.stringify(profile));
    const gate = {
      schemaVersion: 2,
      profiles: [
        {
          id: "format",
          packageManager: "pnpm",
          concurrency: 1,
          tasks: [{ id: "retained", needs: [], after: [] }],
        },
      ],
    };
    await f.put("gates.yaml", JSON.stringify(gate));
    const reader = createFormatObservations({
      census: createSourceCensusReader({ read: readContainedRegularFile }),
      readFile: readContainedRegularFile,
      readYaml: loadStrictYamlFile,
      assertSchema,
      readGates: (root, path, signal) =>
        loadQualityGatePolicy({ readYaml: loadStrictYamlFile, assertSchema }, root, path, signal),
    });
    const input = { consumerRoot: f.root, configPath: "format.yaml" };
    const observation = await reader.read(input);
    assert.ok(observation.paths.includes("gates.yaml"));
    assert.deepEqual(observation.authorities, ["retained"]);
    await reader.verify(input, observation);
    await f.put("ignored-new.json", "{}\n");
    await assert.rejects(reader.verify(input, observation), /universe or source bytes changed/u);
    await f.put(
      "gates.yaml",
      JSON.stringify({ ...gate, profiles: [{ ...gate.profiles[0], concurrency: 2 }] }),
    );
    await assert.rejects(reader.read(input), /blocking authority chain/u);
    await f.put("gates.yaml", JSON.stringify(gate));
    await f.put(
      "package.json",
      JSON.stringify({
        scripts: {
          "format:check": "agent-teams-foundation quality format --consumer .",
          check: "pnpm format:check",
          retained: "true",
        },
      }),
    );
    await assert.rejects(reader.read(input), /explicit contained read-only validator/u);
  });
}
