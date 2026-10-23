import { featureModuleProgram } from "./packed-feature-module-program.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
const foundationName = "@agent-teams/engineering-foundation";
const minimumFoundation = Object.freeze({
  kind: "published-minimum",
  version: "1.8.0",
  specifier: "1.8.0",
  registry: "https://registry.npmjs.org/",
  integrity:
    "sha512-19KGXMEJIUInAUZaEC5Oh1m1ldZbQIzFL880xVG523h0vl7EbkqojqkF0y7JLnRjXi4qIW7vNcChWzam23uUmQ==",
});
async function installNodeConsumer({
  name,
  artifact,
  artifacts,
  foundation,
  temporaryRoot,
  packageManager,
  typescript,
  runPnpm,
}) {
  const directory = join(temporaryRoot, `feature-module-standard-${foundation.kind}-consumer`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "feature-module-standard-packed-TEST",
        private: true,
        type: "module",
        packageManager,
        devDependencies: {
          [name]: artifact.archiveFileSpecifier,
          [foundationName]: foundation.specifier,
          typescript,
        },
      },
      null,
      2,
    )}\n`,
  );
  if (foundation.kind === "qualified-current-archive") {
    await writeFile(
      join(directory, "pnpm-workspace.yaml"),
      `overrides:\n${["repository-mutation", "document-authoring"]
        .map(
          (localName) =>
            `  "@agent-teams/${localName}": ${JSON.stringify(artifacts[`@agent-teams/${localName}`].archiveFileSpecifier)}`,
        )
        .join("\n")}\n`,
    );
  } else {
    await writeFile(join(directory, "pnpm-workspace.yaml"), "packages: []\n");
  }
  await runPnpm(
    [
      "install",
      "--ignore-scripts",
      "--strict-peer-dependencies",
      "--registry=https://registry.npmjs.org/",
    ],
    directory,
  );
  const lock = parse(await readFile(join(directory, "pnpm-lock.yaml"), "utf8"));
  assert.equal(
    lock.overrides?.[foundationName],
    undefined,
    "The direct Foundation peer must be admitted without an override.",
  );
  if (foundation.kind === "published-minimum") {
    assert.equal(lock.importers["."].devDependencies[foundationName].specifier, foundation.version);
    assert.equal(
      lock.packages[`${foundationName}@${foundation.version}`].resolution.integrity,
      foundation.integrity,
    );
    assert.equal(
      lock.overrides,
      undefined,
      "The minimum peer must not use current workspace overrides.",
    );
  }
  return directory;
}
// Uses the caller's already qualified archives. No build or pack occurs here.
function assertNodeSourceChecks(report) {
  if (report.status !== "passed" || report.cases.length !== 11) {
    throw new Error("Packed Feature Module Standard did not complete its public source checks.");
  }
}

export async function verifyPackedFeatureModuleStandard({
  artifacts,
  temporaryRoot,
  packageManager,
  typescript,
  runPnpm,
}) {
  const name = "@agent-teams/feature-module-standard";
  const artifact = artifacts[name];
  const pureDirectory = await createPureDirectory(temporaryRoot);
  await writeFile(
    join(pureDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "feature-module-standard-pure-packed-TEST",
        private: true,
        type: "module",
        packageManager,
        devDependencies: { [name]: artifact.archiveFileSpecifier },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(pureDirectory, "pnpm-workspace.yaml"), "packages: []\n");
  await runPnpm(["install", "--ignore-scripts", "--strict-peer-dependencies"], pureDirectory);
  await writeFile(
    join(pureDirectory, "check.mjs"),
    `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { checkFeatureModule, STANDARD } from "@agent-teams/feature-module-standard";
import { exampleModule, exampleSources } from "@agent-teams/feature-module-standard/fixtures";
const requireFromFms = createRequire(import.meta.resolve("@agent-teams/feature-module-standard/package.json"));
assert.throws(() => import.meta.resolve("@agent-teams/engineering-foundation/package.json"), { code: "ERR_MODULE_NOT_FOUND" });
assert.throws(() => requireFromFms.resolve("@agent-teams/engineering-foundation/package.json"), { code: "MODULE_NOT_FOUND" });
assert.equal(checkFeatureModule(exampleModule()).ok, true);
assert.ok(Object.keys(exampleSources()).length > 0);
assert.equal(STANDARD.version, "v1.1");
console.log(JSON.stringify({ status: "passed", cases: ["pure-entries-without-foundation"] }));
`,
  );
  const pureRuntime = await runPnpm(["exec", "node", "check.mjs"], pureDirectory);
  const pureReport = JSON.parse(pureRuntime.stdout);
  if (
    pureReport.status !== "passed" ||
    pureReport.cases.length !== 1 ||
    pureReport.cases[0] !== "pure-entries-without-foundation"
  ) {
    throw new Error(
      "Packed Feature Module Standard did not verify its pure entries without Foundation.",
    );
  }
  const qualifications = [];
  for (const foundation of [
    {
      kind: "qualified-current-archive",
      version: artifacts[foundationName].packageVersion,
      specifier: artifacts[foundationName].archiveFileSpecifier,
    },
    minimumFoundation,
  ]) {
    const directory = await installNodeConsumer({
      name,
      artifact,
      artifacts,
      foundation,
      temporaryRoot,
      packageManager,
      typescript,
      runPnpm,
    });
    await writeFile(
      join(directory, "check.ts"),
      `
  import { checkFeatureModule, STANDARD } from "@agent-teams/feature-module-standard";
  import { exampleModule, exampleSources } from "@agent-teams/feature-module-standard/fixtures";
  import { checkFeatureModuleOnDisk, formatNodeReport } from "@agent-teams/feature-module-standard/node";
  import type { NodeCheckConfig, NodeReport } from "@agent-teams/feature-module-standard/node";
  const config: NodeCheckConfig = { consumerRoot: ".", sourceRoots: ["src"],
    structure: { featureRoots: [], roleRoots: [] }, moduleComposition: [] };
  const pending: Promise<NodeReport> = checkFeatureModuleOnDisk(config);
  void pending.then(report => formatNodeReport(report));
  void checkFeatureModule(exampleModule()); void exampleSources(); void STANDARD;
  `,
    );
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: [],
        },
        files: ["check.ts"],
      }),
    );
    await runPnpm(["exec", "tsc", "--project", "tsconfig.json"], directory);
    await writeFile(join(directory, "check.mjs"), featureModuleProgram);
    const runtime = await runPnpm(["exec", "node", "check.mjs", foundation.version], directory);
    const report = JSON.parse(runtime.stdout);
    assertNodeSourceChecks(report);
    const evidence = {
      ...report,
      foundation,
      cases: [...pureReport.cases, ...report.cases],
      packageName: artifact.packageName,
      packageVersion: artifact.packageVersion,
      archiveSha256: createHash("sha256")
        .update(await readFile(artifact.archivePath))
        .digest("hex"),
      typescript,
      pureLockfileSha256: createHash("sha256")
        .update(await readFile(join(pureDirectory, "pnpm-lock.yaml")))
        .digest("hex"),
      lockfileSha256: createHash("sha256")
        .update(await readFile(join(directory, "pnpm-lock.yaml")))
        .digest("hex"),
    };
    process.stdout.write(
      `Packed Feature Module Standard conformance PASS: ${JSON.stringify(evidence)}\n`,
    );
    qualifications.push(evidence);
  }
  return qualifications;
}

async function createPureDirectory(temporaryRoot) {
  const directory = join(temporaryRoot, "feature-module-standard-pure-consumer");
  await mkdir(directory, { recursive: true });
  return directory;
}
