import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse, stringify } from "yaml";

import {
  applyFilesystemScaffold,
  planScaffoldFromFile
} from "../packages/engineering-foundation/dist/scaffolding/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-library-consumer"
);
const requireFromTest = createRequire(import.meta.url);
const typescriptCliPath = join(
  dirname(requireFromTest.resolve("typescript/package.json")),
  "bin",
  "tsc"
);

const cases = [
  {
    intent: "intents/create-alpha.yaml",
    id: "synthetic.alpha",
    path: "packages/alpha",
    packageName: "alpha-library",
    role: "synthetic-alpha",
    ownerDocument: "OWNER-ALPHA",
    tsconfigBase: "../../tsconfig.json"
  },
  {
    intent: "intents/create-beta.yaml",
    id: "synthetic.beta",
    path: "packages/deep/nested/beta",
    packageName: "@fixture/beta-library",
    role: "synthetic.beta",
    ownerDocument: "OWNER-BETA",
    tsconfigBase: "../../../../tsconfig.json"
  },
  {
    intent: "intents/create-gamma.yaml",
    id: "synthetic.gamma",
    path: "tooling/gamma",
    packageName: "@another/gamma-library",
    role: "synthetic/gamma",
    ownerDocument: "OWNER-GAMMA",
    tsconfigBase: "../../tsconfig.json"
  }
];

async function createConsumer() {
  const root = await mkdtemp(join(tmpdir(), "foundation-library-recipe-"));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

async function plan(root, intent, configPath) {
  return planScaffoldFromFile({
    consumerRoot: root,
    intentPath: intent,
    ...(configPath === undefined ? {} : { configPath })
  });
}

function operationSource(scaffoldPlan, suffix) {
  const operation = scaffoldPlan.operations.find(({ path }) => path.endsWith(suffix));
  assert.ok(operation, `Missing generated operation ending in ${suffix}.`);
  return Buffer.from(operation.after.contentBase64, "base64").toString("utf8");
}

function expectedManifest(entry) {
  return {
    name: entry.packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      build: "tsc --project tsconfig.json --pretty false",
      check: "pnpm run clean && pnpm run typecheck && pnpm run build && pnpm run test",
      clean: "node -e \"const fs=require('node:fs'); for (const path of ['dist','.cache']) fs.rmSync(path, { recursive: true, force: true })\"",
      prepack: "pnpm run clean && pnpm run build",
      test: "node --test --test-concurrency=1",
      typecheck: "tsc --project tsconfig.json --noEmit --pretty false"
    },
    agentTeamsArchitecture: {
      role: entry.role,
      ownerDocument: entry.ownerDocument
    },
    files: ["dist"],
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js"
      }
    }
  };
}

function expectedTsconfig(entry) {
  return {
    extends: entry.tsconfigBase,
    compilerOptions: {
      composite: true,
      declaration: true,
      declarationMap: true,
      noEmit: false,
      outDir: "dist",
      rootDir: "src",
      tsBuildInfoFile: ".cache/tsconfig.tsbuildinfo"
    },
    include: [
      "src/**/*.ts",
      "src/**/*.tsx",
      "src/**/*.mts",
      "src/**/*.cts"
    ]
  };
}

test("renders one generic library boundary across consumer-owned roles, paths, and package names", async () => {
  for (const entry of cases) {
    const root = await createConsumer();
    try {
      const first = await plan(root, entry.intent);
      const second = await plan(root, entry.intent);
      assert.deepEqual(first, second);
      assert.equal(first.target.id, entry.id);
      assert.equal(first.authorityEvidence.ownerDocument.id, entry.ownerDocument);
      assert.equal(
        operationSource(first, "/package.json"),
        `${JSON.stringify(expectedManifest(entry), null, 2)}\n`
      );
      assert.deepEqual(
        JSON.parse(operationSource(first, "/package.json")),
        expectedManifest(entry)
      );
      assert.equal(
        operationSource(first, "/tsconfig.json"),
        `${JSON.stringify(expectedTsconfig(entry), null, 2)}\n`
      );
      assert.deepEqual(
        JSON.parse(operationSource(first, "/tsconfig.json")),
        expectedTsconfig(entry)
      );
      assert.equal(operationSource(first, "/src/index.ts"), "export {};\n");

      const receipt = await applyFilesystemScaffold(root, first);
      assert.equal(receipt.outcome, "applied");
      assert.equal((await applyFilesystemScaffold(root, first)).outcome, "already-applied");
      assert.equal(
        await readFile(join(root, entry.path, "package.json"), "utf8"),
        operationSource(first, "/package.json")
      );
      const typecheck = spawnSync(
        process.execPath,
        [
          typescriptCliPath,
          "--project",
          join(root, entry.path, "tsconfig.json"),
          "--pretty",
          "false"
        ],
        { encoding: "utf8" }
      );
      assert.equal(typecheck.status, 0, `${typecheck.stdout}${typecheck.stderr}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("keeps role admission and recipe parameters closed in the consumer composition", async () => {
  const root = await createConsumer();
  try {
    const intentPath = join(root, "intents", "invalid-parameters.yaml");
    await writeFile(
      intentPath,
      "schemaVersion: 1\ncompositionId: library-boundary\ntargetRef: synthetic.alpha\nrecipeParameters:\n  application: true\n",
      "utf8"
    );
    await assert.rejects(
      plan(root, "intents/invalid-parameters.yaml"),
      /additional properties/u
    );

    const configPath = join(root, "architecture", "foundation", "scaffolding.yaml");
    const source = await readFile(configPath, "utf8");
    const configuration = parse(source);
    const fixedParameterConfiguration = structuredClone(configuration);
    fixedParameterConfiguration.compositions[0].fixedRecipeParameters = {
      application: true
    };
    await writeFile(
      configPath,
      stringify(fixedParameterConfiguration),
      "utf8"
    );
    await assert.rejects(plan(root, cases[0].intent), /additional properties/u);

    const roleConfiguration = structuredClone(configuration);
    roleConfiguration.compositions[0].targetRoles = [
      "synthetic.beta",
      "synthetic/gamma"
    ];
    await writeFile(
      configPath,
      stringify(roleConfiguration),
      "utf8"
    );
    await assert.rejects(
      plan(root, cases[0].intent),
      /is not admitted by composition/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
