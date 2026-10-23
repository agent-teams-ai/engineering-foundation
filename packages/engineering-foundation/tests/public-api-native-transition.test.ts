import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertSchema } from "../dist/schema-catalog.js";
import { parseArguments } from "../dist/features/command-host/adapters/inbound/cli/cli-arguments.js";
import {
  createPublicApiCompatibilityDependencies,
  createPublicApiArtifactDependencies,
} from "../dist/capabilities/public-api-compatibility/module.js";
import { AjvJsonSchemaReleaseInspector } from "../dist/capabilities/contract-json-schema-releases/module.js";
import {
  readContainedRegularFile,
  pathTraversesSymbolicLink,
} from "../dist/source-inventory/node.js";
import { parseStrictYamlSource } from "../dist/features/configuration-input/yaml.js";
import { readAcceptedArchitectureDecisionEvidence } from "../dist/capabilities/governance-architecture-decisions/module.js";
import { loadNativeTransitionRequest } from "../dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-native-tool-transition.js";
import { observeNativeMigration } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/observe-native-tool-transition.js";
import { migrationBytes } from "../dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-tool-transition-content.js";
import { runNativePublicApiTransition } from "../dist/capabilities/public-api-compatibility/node.js";
import type {
  PublicApiCompatibilityPolicy,
  PublicApiSnapshot,
} from "../dist/capabilities/public-api-compatibility/application/model/public-api.js";
import type { NativeMigrationReview } from "../dist/capabilities/public-api-compatibility/application/model/native-tool-transition.js";
const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const accepted = (input: Parameters<typeof readAcceptedArchitectureDecisionEvidence>[0]) =>
  readAcceptedArchitectureDecisionEvidence(input, assertSchema);
const inspector = new AjvJsonSchemaReleaseInspector({ read: readContainedRegularFile });
async function put(root: string, path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}
function archive(files: Readonly<Record<string, string>>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 100);
    header.write("0000644\0", 100, 8);
    header.write("0000000\0", 108, 8);
    header.write("0000000\0", 116, 8);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
async function fixture(
  action: (f: {
    root: string;
    request: string;
    policy: PublicApiCompatibilityPolicy;
    payload: Record<string, unknown>;
    originals: readonly Buffer[];
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "foundation-native-transition-"));
  const candidate = join(root, "candidate");
  const released = join(root, "released");
  const typed = createPublicApiCompatibilityDependencies(accepted, assertSchema);
  const policy: PublicApiCompatibilityPolicy = {
    schemaVersion: 1,
    acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json",
    changesetDirectory: ".changeset",
    packages: ["one", "two"].map((name) => ({
      packageName: `@transition/${name}`,
      packageRoot: `packages/${name}`,
      manifestPath: `packages/${name}/package.json`,
      tsconfigPath: `packages/${name}/tsconfig.json`,
      releasedBaselinePath: `architecture/public-api/${name}.json`,
      entrypoints: [{ exportPath: ".", declarationEntryPoint: `packages/${name}/dist/index.d.ts` }],
      nonTypeExports: [],
      approvedBreakingChanges: [],
    })),
  };
  const inputs = [];
  const originals: Buffer[] = [];
  try {
    await put(
      candidate,
      "foundation.config.yaml",
      "schemaVersion: 1\nproject:\n  id: transition-fixture\ncapabilities:\n  package.public-api-compatibility:\n    configPath: policy.yaml\n",
    );
    // Strict YAML accepts JSON, retaining one policy value for the real public route.
    await put(candidate, "policy.yaml", migrationBytes(policy));
    await put(
      candidate,
      "architecture/decisions/accepted-decisions.json",
      migrationBytes({ schemaVersion: 1, algorithm: "sha256", decisions: [] }),
    );
    await put(
      candidate,
      ".changeset/transition.md",
      '---\n"@transition/one": minor\n"@transition/two": minor\n---\n\nNative tool transition.\n',
    );
    for (const p of policy.packages) {
      const name = p.packageName.split("/")[1]!;
      const config = migrationBytes({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: false,
        },
        include: ["dist/index.d.ts"],
      });
      const manifest = {
        name: p.packageName,
        version: "0.1.0",
        type: "module",
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      };
      const files = {
        "package.json": JSON.stringify(manifest),
        "dist/index.d.ts": "export interface Value { readonly value: string; }\n",
        "dist/index.js": "export {};\n",
      };
      for (const [path, value] of Object.entries(files)) {
        await put(released, `${p.packageRoot}/${path}`, value);
      }
      await put(released, p.tsconfigPath, config);
      const actualA = await typed.extractor.extract(released, p, "0.1.0");
      const baseline: PublicApiSnapshot = { ...actualA, extractorVersion: "7.58.12" };
      const baselineBytes = migrationBytes(baseline);
      originals.push(baselineBytes);
      await put(candidate, p.releasedBaselinePath, baselineBytes);
      await put(root, `${name}.baseline.json`, baselineBytes);
      for (const [path, value] of Object.entries({
        ...files,
        "package.json": JSON.stringify(manifest),
      })) {
        await put(candidate, `${p.packageRoot}/${path}`, value);
      }
      await put(candidate, p.tsconfigPath, config);
      const archiveBytes = archive(files);
      await put(root, `${name}.tgz`, archiveBytes);
      inputs.push({ packageName: p.packageName, baselineBytes, archiveBytes, configBytes: config });
    }
    const observation = await observeNativeMigration(
      { consumerRoot: candidate, releasedRoot: released, policy, packages: inputs },
      {
        typed,
        artifacts: () =>
          createPublicApiArtifactDependencies(candidate, policy.packages, typed, inspector),
        evidence: {
          files: { read: readContainedRegularFile },
          paths: { traversesSymbolicLink: pathTraversesSymbolicLink },
        },
        assertSchema,
      },
    );
    const review: NativeMigrationReview = {
      kind: "foundation:public-api-native-migration:review:1",
      from: "7.58.12",
      to: "typescript-native/7.0.2",
      baselineSourceCommit: "a".repeat(40),
      policyDigest: observation.policyDigest,
      toolDiffDigest: observation.toolDiffDigest,
      packages: observation.packages.map((row) => ({
        packageName: row.packageName,
        baselinePath: policy.packages.find((p) => p.packageName === row.packageName)!
          .releasedBaselinePath,
        baselineDigest: row.baselineDigest,
        archiveDigest: row.archiveDigest,
        archiveIntegrity: row.archiveIntegrity,
        configDigest: row.configDigest,
        releasedInputsDigest: row.releasedInputsDigest,
        nativeReleasedDigest: row.nativeReleasedDigest,
      })),
    };
    const payload = {
      schemaVersion: 1,
      kind: "foundation:public-api-native-transition:1",
      releasedRoot: "released",
      review,
      packages: policy.packages.map((p) => ({
        packageName: p.packageName,
        baselineInputPath: `${p.packageName.split("/")[1]}.baseline.json`,
        archivePath: `${p.packageName.split("/")[1]}.tgz`,
        configPath: `released/${p.tsconfigPath}`,
      })),
      configurationFiles: [],
    };
    const request = join(root, "request.json");
    await writeFile(request, migrationBytes(payload));
    await action({ root: candidate, request, policy, payload, originals });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function run(root: string, request: string, qualificationOnly: boolean) {
  return runNativePublicApiTransition(
    { consumerRoot: root, configPath: "policy.yaml", requestPath: request, qualificationOnly },
    accepted,
    assertSchema,
    inspector,
  );
}

test("native flags belong only to the explicit existing public promotion command", () => {
  assert.equal(
    parseArguments([
      "public-api-promote-release",
      "--native-transition",
      "input.json",
      "--qualification-only",
      "--format",
      "json",
    ]).qualificationOnly,
    true,
  );
  for (const args of [
    ["check", "--native-transition", "input.json"],
    ["public-api-promote-release", "--qualification-only"],
    ["public-api-promote-release", "--native-transition", "a", "--native-transition", "b"],
  ]) {
    assert.throws(() => parseArguments(args), /supported only|requires|only once/u);
  }
});
test("actual public qualification is read-only and the sole public promoter applies both exact postimages", async () =>
  fixture(async (f) => {
    const before = await Promise.all(
      f.policy.packages.map((p) => readFile(join(f.root, p.releasedBaselinePath))),
    );
    const qualified = await execute(
      process.execPath,
      [
        cli,
        "public-api-promote-release",
        "--consumer",
        f.root,
        "--native-transition",
        f.request,
        "--qualification-only",
        "--format",
        "json",
      ],
      { timeout: 120_000, maxBuffer: 8_000_000 },
    );
    const report = JSON.parse(qualified.stdout) as {
      outcome: string;
      migrationApplied: boolean;
      observation: { typedDiagnostics: unknown[]; artifactDiagnostics: unknown[] };
    };
    assert.equal(report.outcome, "qualified");
    assert.equal(report.migrationApplied, false);
    assert.deepEqual(report.observation.typedDiagnostics, []);
    assert.deepEqual(report.observation.artifactDiagnostics, []);
    assert.deepEqual(
      await Promise.all(
        f.policy.packages.map((p) => readFile(join(f.root, p.releasedBaselinePath))),
      ),
      before,
    );
    await assert.rejects(
      execute(
        process.execPath,
        [cli, "public-api-promote-release", "--consumer", f.root, "--format", "json"],
        { timeout: 120_000 },
      ),
      (error) => {
        assert.ok(error instanceof Error && "stdout" in error);
        assert.match(String(error.stdout), /PUBLIC_API_BASELINE_PROMOTION_TOOL_MISMATCH/u);
        return true;
      },
    );
    for (const p of f.policy.packages) {
      const path = join(f.root, p.manifestPath);
      const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await writeFile(path, migrationBytes({ ...manifest, version: "0.2.0" }));
    }
    const applied = await execute(
      process.execPath,
      [
        cli,
        "public-api-promote-release",
        "--consumer",
        f.root,
        "--native-transition",
        f.request,
        "--format",
        "json",
      ],
      { timeout: 120_000, maxBuffer: 8_000_000 },
    );
    const result = JSON.parse(applied.stdout) as {
      outcome: string;
      writes: unknown[];
      observation: { typedDiagnostics: { ruleId: string }[] };
    };
    assert.equal(result.outcome, "promoted");
    assert.equal(result.writes.length, 2);
    assert.equal(result.observation.typedDiagnostics.length, 2);
    assert.ok(
      result.observation.typedDiagnostics.every((row) =>
        row.ruleId.endsWith(".baseline-version-mismatch"),
      ),
    );
    for (const p of f.policy.packages) {
      const value = JSON.parse(
        await readFile(join(f.root, p.releasedBaselinePath), "utf8"),
      ) as PublicApiSnapshot;
      assert.equal(value.packageVersion, "0.2.0");
      assert.equal(value.extractorVersion, "typescript-native/7.0.2");
    }
    const replay = await run(f.root, f.request, false);
    assert.equal(replay.writes.length, 0);
  }));
test("unsupported tools and permit fields reject as content-schema failures", async () =>
  fixture(async (f) => {
    for (const delta of [
      { permit: true },
      { review: { ...(f.payload["review"] as object), to: "different-tool/1" } },
    ]) {
      await writeFile(f.request, migrationBytes({ ...f.payload, ...delta }));
      await assert.rejects(run(f.root, f.request, true));
    }
    assert.deepEqual(
      await Promise.all(
        f.policy.packages.map((p) => readFile(join(f.root, p.releasedBaselinePath))),
      ),
      f.originals,
    );
  }));
test("request paths cannot escape their namespace or use a symlink", async () =>
  fixture(async (f) => {
    const packages = structuredClone(f.payload["packages"]) as { baselineInputPath: string }[];
    packages[0]!.baselineInputPath = "../outside.json";
    await writeFile(f.request, migrationBytes({ ...f.payload, packages }));
    await assert.rejects(run(f.root, f.request, true));
    packages[0]!.baselineInputPath = "baseline-link.json";
    await symlink(
      join(dirname(f.request), "one.baseline.json"),
      join(dirname(f.request), "baseline-link.json"),
    );
    await writeFile(f.request, migrationBytes({ ...f.payload, packages }));
    await assert.rejects(run(f.root, f.request, true));
  }));
test("raw working B drift and released dependency/config drift reject before promotion", async () =>
  fixture(async (f) => {
    const p = f.policy.packages[1]!;
    await writeFile(
      join(f.root, p.releasedBaselinePath),
      Buffer.concat([f.originals[1]!, Buffer.from(" ")]),
    );
    await assert.rejects(run(f.root, f.request, true), /physical baseline/u);
    await writeFile(join(f.root, p.releasedBaselinePath), f.originals[1]!);
    await writeFile(join(dirname(f.request), "released", p.tsconfigPath), "{}\n");
    await assert.rejects(run(f.root, f.request, false), /namespace differs|reviewed/u);
    assert.deepEqual(
      await Promise.all(
        f.policy.packages.map((row) => readFile(join(f.root, row.releasedBaselinePath))),
      ),
      f.originals,
    );
  }));
test("same-version drift and a new unapproved break cannot pass the opt-in public operation", async () =>
  fixture(async (f) => {
    const p = f.policy.packages[1]!;
    await writeFile(
      join(f.root, p.packageRoot, "dist/index.d.ts"),
      "export interface Value { readonly value: number; }\n",
    );
    for (const version of ["0.1.0", "0.2.0"]) {
      const path = join(f.root, p.manifestPath);
      const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await writeFile(path, migrationBytes({ ...manifest, version }));
      await assert.rejects(
        run(f.root, f.request, false),
        /changed after baseline|Breaking API fingerprint is not approved/u,
      );
    }
    assert.deepEqual(
      await Promise.all(
        f.policy.packages.map((row) => readFile(join(f.root, row.releasedBaselinePath))),
      ),
      f.originals,
    );
  }));

test("the owning release fence runs after preparation and can prevent every physical write", async () =>
  fixture(async (f) => {
    let reached = false;
    await assert.rejects(
      runNativePublicApiTransition(
        {
          consumerRoot: f.root,
          configPath: "policy.yaml",
          requestPath: f.request,
          qualificationOnly: false,
        },
        accepted,
        assertSchema,
        inspector,
        async () => {
          reached = true;
          throw new Error("stale protected source");
        },
      ),
      /stale protected source/u,
    );
    assert.equal(reached, true);
    assert.deepEqual(
      await Promise.all(
        f.policy.packages.map((p) => readFile(join(f.root, p.releasedBaselinePath))),
      ),
      f.originals,
    );
  }));

test("the request loader bounds aggregate raw inputs before allocation and rejects reader overreturn", async () =>
  fixture(async (f) => {
    const directory = dirname(f.request);
    const largePath = join(directory, "large.json");
    const chunkBytes = 16 * 1024 * 1024;
    await writeFile(largePath, Buffer.alloc(chunkBytes, 32));
    const configurationFiles = Array.from({ length: 9 }, (_, index) => ({
      path: `config-${index}.json`,
      inputPath: "large.json",
    }));
    await writeFile(f.request, migrationBytes({ ...f.payload, configurationFiles }));
    const limits: number[] = [];
    let completedBytes = 0;
    const evidence = {
      paths: { traversesSymbolicLink: pathTraversesSymbolicLink },
      parseYaml: parseStrictYamlSource,
      files: {
        read: async (input: Parameters<typeof readContainedRegularFile>[0]) => {
          if (input.candidate === largePath) {
            limits.push(input.maxBytes);
          }
          const bytes = await readContainedRegularFile(input);
          if (input.candidate !== f.request) {
            completedBytes += bytes.byteLength;
          }
          return bytes;
        },
      },
    };
    await assert.rejects(loadNativeTransitionRequest(f.root, f.request, assertSchema, evidence));
    assert.equal(limits.length, 8, "the eighth 16MiB file must be rejected before the ninth read");
    assert.ok(limits.slice(0, -1).every((limit) => limit >= chunkBytes));
    assert.equal(limits.at(-1), 128 * 1024 * 1024 - completedBytes);
    assert.ok(
      limits.at(-1)! < chunkBytes,
      "the regular-file reader must receive the remaining aggregate budget",
    );

    await writeFile(f.request, migrationBytes(f.payload));
    let returnedTooManyBytes = false;
    await assert.rejects(
      loadNativeTransitionRequest(f.root, f.request, assertSchema, {
        ...evidence,
        files: {
          read: async (input) => {
            if (input.candidate === f.request) {
              return readContainedRegularFile(input);
            }
            returnedTooManyBytes = true;
            return new Uint8Array(input.maxBytes + 1);
          },
        },
      }),
      /historical request input byte budget exceeded/u,
    );
    assert.equal(returnedTooManyBytes, true);
    assert.deepEqual(
      await Promise.all(
        f.policy.packages.map((p) => readFile(join(f.root, p.releasedBaselinePath))),
      ),
      f.originals,
    );
  }));
