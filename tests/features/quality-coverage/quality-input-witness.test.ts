import { registerQualityInputBudgetCases } from "./quality-input-budget-cases.ts";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CapabilityInputError,
  checkQualityCoverage,
  checkStaticQualityCoverage,
  createQualityCoverageCapability,
  type QualityCoverageObservation,
  type QualityFileReader,
  type QualityObservationPorts,
  type QualityToolProvider,
} from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
import {
  createQualityInputWitness,
  QUALITY_INPUT_LIMITS,
} from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/quality-input-witness.js";
import { admitQualityProfileVersion } from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/configuration.js";
import { createOxlintSession } from "../../../packages/engineering-foundation/dist/features/quality-coverage/node.js";
import { readContainedRegularFile } from "../../../packages/engineering-foundation/dist/source-inventory/node.js";
import { qualitySessionFixture } from "./quality-session-fixture.ts";

registerQualityInputBudgetCases();

function census(paths: () => readonly string[]): QualityObservationPorts["census"] {
  return {
    async read(input) {
      assert.equal(input.generatedDirectories, "observe");
      assert.deepEqual(input.roots, ["."]);
      assert.equal(input.maxFiles, 100_000);
      return { filePaths: paths(), sourcePaths: [], manifestPaths: [] };
    },
  };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quality-inputs-")));
  await writeFile(join(root, "source.ts"), "export const value = 1;\n");
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

void test("whole input witness rejects bytes, additions and deletions before accepting tool evidence", async () => {
  for (const mutation of ["bytes", "add", "delete"] as const) {
    const temporary = await fixture();
    try {
      let paths = ["source.ts"];
      const witness = createQualityInputWitness(temporary.root, readContainedRegularFile);
      await witness.capture(census(() => paths));
      if (mutation === "bytes") {
        await writeFile(join(temporary.root, "source.ts"), "changed");
      }
      if (mutation === "add") {
        paths = [...paths, "new.json"];
      }
      if (mutation === "delete") {
        paths = [];
      }
      await assert.rejects(witness.verify(), CapabilityInputError, mutation);
    } finally {
      await temporary.dispose();
    }
  }
});

void test("regular same-byte replacement is accepted, final bytes are rechecked, and fourth snapshot rejects", async () => {
  const temporary = await fixture();
  try {
    const witness = createQualityInputWitness(temporary.root, readContainedRegularFile);
    await witness.capture(census(() => ["source.ts"]));
    await writeFile(
      join(temporary.root, "replacement"),
      await readFile(join(temporary.root, "source.ts")),
    );
    await rename(join(temporary.root, "replacement"), join(temporary.root, "source.ts"));
    await witness.verify();
    await witness.verify();
    await assert.rejects(witness.verify(), /three-snapshot/u);
    const changed = createQualityInputWitness(temporary.root, readContainedRegularFile);
    await changed.capture(census(() => ["source.ts"]));
    await changed.verify();
    await writeFile(join(temporary.root, "source.ts"), "changed after tools began");
    await assert.rejects(changed.verify(), /changed/u);
  } finally {
    await temporary.dispose();
  }
});

void test("protected installed files outside the ordinary census retain byte custody", async () => {
  const temporary = await fixture();
  try {
    await mkdir(join(temporary.root, "node_modules"));
    const candidate = join(temporary.root, "node_modules", "preset.json");
    await writeFile(candidate, "{}");
    const witness = createQualityInputWitness(temporary.root, readContainedRegularFile);
    await witness.capture(census(() => ["source.ts"]));
    await witness.read({ root: temporary.root, candidate, maxBytes: 1024 });
    await writeFile(candidate, '{"rules":{}}');
    await assert.rejects(witness.verify(), /changed/u);
  } finally {
    await temporary.dispose();
  }
});

void test("protected package alias rewiring rejects even when Node caches its original resolution", async () => {
  const temporary = await fixture();
  try {
    for (const name of ["first", "second"]) {
      await mkdir(join(temporary.root, name));
      await writeFile(join(temporary.root, name, "package.json"), '{"name":"lint-preset"}');
    }
    await mkdir(join(temporary.root, "node_modules"));
    const alias = join(temporary.root, "node_modules", "lint-preset");
    await symlink(join(temporary.root, "first"), alias, "junction");
    const issuer = join(temporary.root, "package.json");
    const request = "lint-preset/package.json";
    const target = createRequire(issuer).resolve(request);
    const witness = createQualityInputWitness(temporary.root, readContainedRegularFile);
    await witness.capture(census(() => ["source.ts"]));
    await witness.bindResolution({
      issuer,
      request,
      target,
      logicalTarget: join(alias, "package.json"),
      aliases: [{ path: alias, target: join(temporary.root, "first") }],
    });
    await rm(alias);
    await symlink(join(temporary.root, "second"), alias, "junction");
    await assert.rejects(witness.verify(), /aliases changed/u);
  } finally {
    await temporary.dispose();
  }
});

void test("unique file, per-read, unique-byte and cumulative-byte limits stop before additional reads", async () => {
  let reads = 0;
  const block = new Uint8Array(QUALITY_INPUT_LIMITS.fileBytes);
  const read: QualityFileReader = async ({ maxBytes }) => {
    reads += 1;
    assert.ok(maxBytes <= QUALITY_INPUT_LIMITS.fileBytes);
    return block;
  };
  const oversized = createQualityInputWitness("/consumer", read);
  await assert.rejects(
    oversized.capture(census(() => Array.from({ length: 100_001 }, (_, i) => `${i}.ts`))),
    /file budget/u,
  );
  assert.equal(reads, 0);
  const unique = createQualityInputWitness("/consumer", read);
  for (let i = 0; i < 32; i += 1) {
    await unique.read({
      root: "/consumer",
      candidate: `/consumer/${i}`,
      maxBytes: block.byteLength,
    });
  }
  assert.equal(reads, 32);
  await assert.rejects(
    unique.read({ root: "/consumer", candidate: "/consumer/extra", maxBytes: 1 }),
    /unique input byte budget/u,
  );
  assert.equal(reads, 32);
  const cumulative = createQualityInputWitness("/consumer", read);
  for (let i = 0; i < 128; i += 1) {
    await cumulative.readToolFile({
      root: "/consumer",
      candidate: "/consumer/tool",
      maxBytes: block.byteLength,
    });
  }
  await assert.rejects(
    cumulative.readToolFile({ root: "/consumer", candidate: "/consumer/tool", maxBytes: 1 }),
    /cumulative input read budget/u,
  );
  assert.equal(reads, 160);
  const bounded = createQualityInputWitness("/consumer", async () => new Uint8Array(2));
  await assert.rejects(
    bounded.read({ root: "/consumer", candidate: "/consumer/source", maxBytes: 1 }),
    /bounded read/u,
  );
});

void test("all owner reads share eight concurrent slots and the original monotonic deadline", async () => {
  let active = 0;
  let maximum = 0;
  let now = 0;
  const witness = createQualityInputWitness(
    "/consumer",
    async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      active -= 1;
      return new Uint8Array(1);
    },
    undefined,
    () => now,
  );
  witness.setBudget(1000);
  await Promise.all(
    Array.from({ length: 32 }, (_, i) =>
      witness.read({ root: "/consumer", candidate: `/consumer/${i}`, maxBytes: 1 }),
    ),
  );
  assert.equal(maximum, 8);
  now = 999;
  assert.equal(witness.remainingMs(), 1);
  now = 1000;
  await assert.rejects(
    witness.readToolFile({ root: "/consumer", candidate: "/consumer/tool", maxBytes: 1 }),
    /original quality invocation budget/u,
  );
  const controller = new AbortController();
  const cancelled = createQualityInputWitness(
    "/consumer",
    readContainedRegularFile,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(cancelled.capture(census(() => [])), /cancelled/u);
});

const observation: QualityCoverageObservation = {
  sources: [{ path: "source.ts", owners: ["source"], suppressionCovered: true }],
  testPaths: [],
  requiredSettings: ["typeAware"],
  requiredSettingObservations: [
    {
      observationId: "lint#typeAware",
      path: "lint.json",
      name: "typeAware",
      expected: "true",
      comparison: "equal",
    },
  ],
  settings: [
    {
      observationId: "lint#typeAware",
      path: "lint.json",
      name: "typeAware",
      expected: "true",
      actual: "true",
      comparison: "equal",
    },
  ],
  requiredRoutes: [
    { entry: "fast", mode: "scope" },
    { entry: "full", mode: "full" },
  ],
  routes: [
    { entry: "fast", mode: "scope", reached: true },
    { entry: "full", mode: "full", reached: true },
  ],
};

void test("one captured session reaches tools, verifies before spawn and after lint, and reports v5", async () => {
  const events: string[] = [];
  const captured = qualitySessionFixture(observation, {
    verify: async () => {
      events.push("verify");
    },
  });
  const reader = { read: async () => captured };
  const provider: QualityToolProvider = {
    async prepare(received) {
      assert.equal(received, captured);
      events.push("prepare");
      return {
        select: async () => {
          events.push("select");
          return ["source.ts"];
        },
        typeContext: async () => {
          events.push("context");
          return ["source.ts"];
        },
        explicitUnknown: async () => {
          events.push("scan");
          return [];
        },
        lint: async () => {
          events.push("lint");
          return { files: 1, diagnostics: [] };
        },
      };
    },
  };
  const invocation = { consumerRoot: "/consumer", configPath: "quality.yaml", scopeOnly: false };
  const result = await checkQualityCoverage(invocation, reader, provider);
  assert.equal(result.outcome, "passed");
  assert.equal(result.capabilityConfigSchemaVersion, 5);
  assert.deepEqual(events, ["prepare", "verify", "select", "context", "scan", "lint", "verify"]);
  events.length = 0;
  assert.equal((await checkStaticQualityCoverage(invocation, reader)).outcome, "passed");
  assert.deepEqual(events, ["verify"]);
  assert.equal(createQualityCoverageCapability(reader).configSchemaVersion, 5);
  for (const version of [1, 2, 3, 4, 6]) {
    const rejected = await checkStaticQualityCoverage(invocation, {
      async read(_root, _path, _signal, observe) {
        admitQualityProfileVersion({ schemaVersion: version }, observe);
        return captured;
      },
    });
    assert.equal(rejected.outcome, "invalid-input");
    assert.equal(rejected.capabilityConfigSchemaVersion, version);
  }
});

void test("each actual process receives the remainder instead of a restarted timeout", async () => {
  let remaining = 950;
  const timeouts: (number | undefined)[] = [];
  const session = createOxlintSession(
    {
      consumerRoot: "/consumer",
      nodeExecutable: "/node",
      oxlintEntrypoint: "oxlint",
      compilerEntrypoint: "tsc",
      configPath: "lint.json",
      sourceRoots: ["source.ts"],
      projects: [],
      remainingMs: () => remaining,
    },
    {
      async run(request) {
        timeouts.push(request.timeoutMs);
        remaining -= 300;
        return {
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: request.args.includes("--debug")
            ? "source.ts\n"
            : '{"diagnostics":[],"number_of_files":1}',
        };
      },
    },
  );
  await session.select();
  await session.lint();
  assert.deepEqual(timeouts, [950, 650]);
});
