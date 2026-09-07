import { registerInstructionObservationPortCases } from "./repository-agent-workflow/observation-port-cases.mjs";
registerInstructionObservationPortCases();
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";

import { check, cliPath, withAgentWorkflowFixture as withUnmarkedAgentWorkflowFixture } from "./support/capability-fixtures.mjs";
import { sha256Bytes, sha256Json } from "../packages/repository-mutation/dist/serialization.js";
import { ContainedFileReadError, inspectContainedRegularFile, readContainedRegularFile } from "../packages/engineering-foundation/dist/source-inventory/node.js";
import { FilesystemEffectiveInstructionsReader } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/filesystem/filesystem-effective-instructions-reader.js";
import { resolveEffectiveInstructions } from "../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/application/use-cases/resolve-effective-instructions.js";

const instructionObservation = { read: readContainedRegularFile, inspect: inspectContainedRegularFile };
async function withAgentWorkflowFixture(callback) {
  return withUnmarkedAgentWorkflowFixture(async (root) => {
    await writeFile(join(root, "DISPOSABLE_SANDBOX"), "Instruction reader test fixture.\n");
    return callback(root);
  });
}

const instructionSemantics =
  "foundation-safe-codex-default-project-instructions-v1";
const instructionBudgetBytes = 32 * 1024;

function instructionFile(path, bytes) {
  return Object.freeze({
    kind: "file",
    path,
    sourceBytes: bytes.byteLength,
    bytes,
  });
}

function unreadInstructionFile(path, sourceBytes) {
  return Object.freeze({
    kind: "file",
    path,
    sourceBytes,
    bytes: null,
  });
}

function instructionReader({ targetPath, directories, observations, reads = [] }) {
  return {
    async discover() {
      return Object.freeze({
        targetPath,
        targetDirectory: "src",
        directories: Object.freeze([...directories]),
      });
    },
    async readDirectory(input) {
      reads.push(Object.freeze({
        directory: input.directory,
        readSelectedBytes: input.readSelectedBytes,
      }));
      const candidates = observations.get(input.directory);
      assert.notEqual(candidates, undefined);
      return Object.freeze({
        directory: input.directory,
        candidates,
      });
    },
  };
}

function expectedResolutionDigest(targetPath, sources) {
  return sha256Json({
    semantics: instructionSemantics,
    sources: sources.map(({ path, bytes }) => ({
      path,
      loadedBytes: bytes.byteLength,
      loadedDigest: sha256Bytes(bytes),
    })),
    targetPath,
  });
}


function runInstructions(consumerRoot, targetPath, format = "json", ...args) {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "agent-workflow",
      "instructions",
      targetPath,
      "--consumer",
      consumerRoot,
      "--format",
      format,
      ...args,
    ],
    { encoding: "utf8" },
  );
  return {
    result,
    report: format === "json" && result.stdout.length > 0
      ? JSON.parse(result.stdout)
      : null,
  };
}

function runAgentWorkflowRaw(...args) {
  const result = spawnSync(
    process.execPath,
    [cliPath, "agent-workflow", ...args, "--format", "json"],
    { encoding: "utf8" },
  );
  return { result, report: JSON.parse(result.stdout) };
}

test("accepts one canonical instruction source with portable adapters", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0);
    assert.equal(report.outcome, "passed");
    assert.equal(report.capabilities[0].capabilityId, "repository.agent-workflow");
  });
});

test("resolves effective instructions root-to-target with explicit shadowing", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    await writeFile(
      join(consumerRoot, "src", "AGENTS.md"),
      "x".repeat(300_000),
      "utf8",
    );
    await writeFile(
      join(consumerRoot, "src", "AGENTS.override.md"),
      "# Effective source instructions\n",
      "utf8",
    );

    const { result, report } = runInstructions(consumerRoot, "src/index.ts");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.outcome, "resolved");
    assert.equal(
      report.semantics,
      "foundation-safe-codex-default-project-instructions-v1",
    );
    assert.deepEqual(
      report.layers.map((layer) => ({
        path: layer.selectedPath,
        scope: layer.scope,
        status: layer.status,
        canOverrideEarlier: layer.canOverrideEarlier,
        shadowed: layer.shadowed.map(({ path }) => path),
      })),
      [
        {
          path: "AGENTS.md",
          scope: "**/*",
          status: "applied",
          canOverrideEarlier: [],
          shadowed: [],
        },
        {
          path: "src/AGENTS.override.md",
          scope: "src/**/*",
          status: "applied",
          canOverrideEarlier: ["AGENTS.md"],
          shadowed: ["src/AGENTS.md"],
        },
      ],
    );
    assert.match(report.resolutionDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(
      report.budget.loadedBytes,
      Buffer.byteLength(await readFile(join(consumerRoot, "AGENTS.md"), "utf8")) +
        Buffer.byteLength("# Effective source instructions\n"),
    );
    assert.equal(report.layers[0].sourceBytes, report.layers[0].loadedBytes);
    assert.equal(report.layers[1].sourceBytes, report.layers[1].loadedBytes);
    const repeated = runInstructions(consumerRoot, "src/index.ts").report;
    assert.equal(repeated.resolutionDigest, report.resolutionDigest);

    await writeFile(join(consumerRoot, "src", "AGENTS.md"), "y".repeat(300_000));
    const shadowChanged = runInstructions(consumerRoot, "src/index.ts").report;
    assert.equal(shadowChanged.resolutionDigest, report.resolutionDigest);

    await writeFile(
      join(consumerRoot, "src", "AGENTS.override.md"),
      "# Changed effective source instructions\n",
    );
    const admittedChanged = runInstructions(consumerRoot, "src/index.ts").report;
    assert.notEqual(admittedChanged.resolutionDigest, report.resolutionDigest);
    const targetChanged = runInstructions(consumerRoot, "src/planned.ts").report;
    assert.notEqual(targetChanged.resolutionDigest, admittedChanged.resolutionDigest);

    const text = runInstructions(consumerRoot, "src/index.ts", "text").result;
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Effective instructions for src\/index\.ts/u);
    assert.match(text.stdout, /Shadowed: src\/AGENTS\.md/u);
  });
});

test("binds the resolution digest only to ordered admitted bytes and target path", async () => {
  const encoder = new TextEncoder();
  const rootBytes = encoder.encode("# Root instructions\n");
  const sourceBytes = encoder.encode("# Source instructions\n");
  const changedSourceBytes = encoder.encode("# Changed source instructions\n");

  async function resolve({
    targetPath = "src/index.ts",
    admittedBytes = sourceBytes,
    shadowedBytes = 91,
  } = {}) {
    const observations = new Map([
      [
        ".",
        Object.freeze([
          Object.freeze({ kind: "missing", path: "AGENTS.override.md" }),
          instructionFile("AGENTS.md", rootBytes),
        ]),
      ],
      [
        "src",
        Object.freeze([
          instructionFile("src/AGENTS.override.md", admittedBytes),
          unreadInstructionFile("src/AGENTS.md", shadowedBytes),
        ]),
      ],
    ]);
    return await resolveEffectiveInstructions(
      { consumerRoot: "/disposable-fixture", targetPath },
      instructionReader({
        targetPath,
        directories: [".", "src"],
        observations,
      }),
    );
  }

  const first = await resolve();
  const repeated = await resolve();
  assert.equal(first.resolutionDigest, repeated.resolutionDigest);
  assert.equal(
    first.resolutionDigest,
    expectedResolutionDigest("src/index.ts", [
      { path: "AGENTS.md", bytes: rootBytes },
      { path: "src/AGENTS.override.md", bytes: sourceBytes },
    ]),
  );

  const shadowedChanged = await resolve({ shadowedBytes: 8_192 });
  assert.equal(shadowedChanged.resolutionDigest, first.resolutionDigest);
  assert.equal(shadowedChanged.layers[1].shadowed[0].path, "src/AGENTS.md");

  const admittedChanged = await resolve({ admittedBytes: changedSourceBytes });
  assert.notEqual(admittedChanged.resolutionDigest, first.resolutionDigest);
  assert.equal(
    admittedChanged.resolutionDigest,
    expectedResolutionDigest("src/index.ts", [
      { path: "AGENTS.md", bytes: rootBytes },
      { path: "src/AGENTS.override.md", bytes: changedSourceBytes },
    ]),
  );

  const targetChanged = await resolve({ targetPath: "src/planned.ts" });
  assert.notEqual(targetChanged.resolutionDigest, first.resolutionDigest);
  assert.equal(
    targetChanged.resolutionDigest,
    expectedResolutionDigest("src/planned.ts", [
      { path: "AGENTS.md", bytes: rootBytes },
      { path: "src/AGENTS.override.md", bytes: sourceBytes },
    ]),
  );
});

test("stops reading instruction content at the exact byte boundary but retains metadata", async () => {
  const boundaryBytes = new TextEncoder().encode("r".repeat(instructionBudgetBytes));
  const reads = [];
  const observations = new Map([
    [
      ".",
      Object.freeze([
        Object.freeze({ kind: "missing", path: "AGENTS.override.md" }),
        instructionFile("AGENTS.md", boundaryBytes),
      ]),
    ],
    [
      "src",
      Object.freeze([
        Object.freeze({ kind: "missing", path: "src/AGENTS.override.md" }),
        unreadInstructionFile("src/AGENTS.md", 400_000),
      ]),
    ],
  ]);
  const report = await resolveEffectiveInstructions(
    { consumerRoot: "/disposable-fixture", targetPath: "src/index.ts" },
    instructionReader({
      targetPath: "src/index.ts",
      directories: [".", "src"],
      observations,
      reads,
    }),
  );

  assert.deepEqual(reads, [
    { directory: ".", readSelectedBytes: true },
    { directory: "src", readSelectedBytes: false },
  ]);
  assert.deepEqual(report.budget, {
    maximumBytes: instructionBudgetBytes,
    loadedBytes: instructionBudgetBytes,
    exhausted: true,
    truncated: false,
  });
  assert.deepEqual(
    report.layers.map((layer) => ({
      selectedPath: layer.selectedPath,
      status: layer.status,
      sourceBytes: layer.sourceBytes,
      loadedBytes: layer.loadedBytes,
      sourceDigest: layer.sourceDigest,
    })),
    [
      {
        selectedPath: "AGENTS.md",
        status: "applied",
        sourceBytes: instructionBudgetBytes,
        loadedBytes: instructionBudgetBytes,
        sourceDigest: sha256Bytes(boundaryBytes),
      },
      {
        selectedPath: "src/AGENTS.md",
        status: "budget-exhausted",
        sourceBytes: 400_000,
        loadedBytes: 0,
        sourceDigest: null,
      },
    ],
  );
  assert.equal(
    report.resolutionDigest,
    expectedResolutionDigest("src/index.ts", [
      { path: "AGENTS.md", bytes: boundaryBytes },
    ]),
  );
});

test("truncates exactly one byte beyond the instruction budget", async () => {
  const source = new TextEncoder().encode(
    `${"a".repeat(instructionBudgetBytes)}z`,
  );
  const admitted = source.slice(0, instructionBudgetBytes);
  const observations = new Map([
    [
      ".",
      Object.freeze([
        Object.freeze({ kind: "missing", path: "AGENTS.override.md" }),
        instructionFile("AGENTS.md", source),
      ]),
    ],
  ]);
  const report = await resolveEffectiveInstructions(
    { consumerRoot: "/disposable-fixture", targetPath: "src/index.ts" },
    instructionReader({
      targetPath: "src/index.ts",
      directories: ["."],
      observations,
    }),
  );

  assert.deepEqual(report.budget, {
    maximumBytes: instructionBudgetBytes,
    loadedBytes: instructionBudgetBytes,
    exhausted: true,
    truncated: true,
  });
  assert.equal(report.layers[0].status, "truncated");
  assert.equal(report.layers[0].sourceBytes, instructionBudgetBytes + 1);
  assert.equal(report.layers[0].loadedBytes, instructionBudgetBytes);
  assert.equal(report.layers[0].sourceDigest, sha256Bytes(source));
  assert.equal(report.layers[0].loadedDigest, sha256Bytes(admitted));
  assert.equal(
    report.resolutionDigest,
    expectedResolutionDigest("src/index.ts", [
      { path: "AGENTS.md", bytes: admitted },
    ]),
  );
});

test("matches Codex lossy UTF-8 and Unicode whitespace admission semantics", async () => {
  const cases = [
    {
      name: "UTF-8 BOM",
      bytes: Uint8Array.from([0xef, 0xbb, 0xbf]),
      status: "applied",
      loadedBytes: 3,
    },
    {
      name: "Unicode next-line whitespace",
      bytes: new TextEncoder().encode("\u0085"),
      status: "ignored-empty",
      loadedBytes: 0,
    },
    {
      name: "malformed UTF-8",
      bytes: Uint8Array.from([0x80]),
      status: "applied",
      loadedBytes: 1,
    },
  ];

  for (const fixture of cases) {
    const observations = new Map([
      [
        ".",
        Object.freeze([
          Object.freeze({ kind: "missing", path: "AGENTS.override.md" }),
          instructionFile("AGENTS.md", fixture.bytes),
        ]),
      ],
    ]);
    const targetPath = "src/index.ts";
    const report = await resolveEffectiveInstructions(
      { consumerRoot: "/disposable-fixture", targetPath },
      instructionReader({
        targetPath,
        directories: ["."],
        observations,
      }),
    );

    assert.equal(report.layers[0].status, fixture.status, fixture.name);
    assert.equal(report.layers[0].loadedBytes, fixture.loadedBytes, fixture.name);
    assert.equal(report.budget.loadedBytes, fixture.loadedBytes, fixture.name);
    assert.equal(
      report.resolutionDigest,
      expectedResolutionDigest(
        targetPath,
        fixture.loadedBytes === 0
          ? []
          : [{ path: "AGENTS.md", bytes: fixture.bytes }],
      ),
      fixture.name,
    );
  }
});

test("observes stable instruction metadata without reading candidate content", async () => {
  const root = resolvePath("disposable-contained-root");
  const sourceDirectory = join(root, "src");
  const candidate = join(sourceDirectory, "AGENTS.md");
  const fileSnapshot = {
    ctimeMs: 1n,
    dev: 1n,
    ino: 2n,
    mode: 0o100644n,
    mtimeMs: 1n,
    size: 1_337n,
    isFile: () => true,
  };
  let readCalls = 0;
  let closeCalls = 0;
  let metadataOpenAllowed = true;
  const operations = {
    async lstat(path) {
      assert.ok(path === sourceDirectory || path === candidate);
      return { isSymbolicLink: () => false };
    },
    async open(path) {
      assert.equal(path, candidate);
      if (!metadataOpenAllowed) {
        const error = new Error("Read access denied.");
        error.code = "EACCES";
        throw error;
      }
      return {
        async close() {
          closeCalls += 1;
        },
        async read() {
          readCalls += 1;
          throw new Error("Metadata inspection must not read content.");
        },
        async stat() {
          return fileSnapshot;
        },
      };
    },
    async realpath(path) {
      assert.ok(path === root || path === candidate);
      return path;
    },
    async stat(path) {
      if (path === root) {
        return {
          ...fileSnapshot,
          isDirectory: () => true,
          isFile: () => false,
        };
      }
      assert.equal(path, candidate);
      return {
        ...fileSnapshot,
        isDirectory: () => false,
      };
    },
  };
  const observation = await inspectContainedRegularFile(
    { candidate, root },
    operations,
  );
  assert.deepEqual(observation, { size: 1_337 });
  assert.equal(readCalls, 0);
  assert.equal(closeCalls, 1);

  metadataOpenAllowed = false;
  await assert.rejects(
    inspectContainedRegularFile({ candidate, root }, operations),
    (error) => {
      assert.ok(error instanceof ContainedFileReadError);
      assert.equal(error.failure, "unavailable");
      return true;
    },
  );
  assert.equal(readCalls, 0);
  assert.equal(closeCalls, 1);
});

test("rejects a metadata-only observation when candidate ancestry changes", async () => {
  const root = resolvePath("disposable-contained-root");
  const sourceDirectory = join(root, "src");
  const candidate = join(sourceDirectory, "AGENTS.md");
  const fileSnapshot = {
    ctimeMs: 1n,
    dev: 1n,
    ino: 2n,
    mode: 0o100644n,
    mtimeMs: 1n,
    size: 1_337n,
    isFile: () => true,
  };
  let sourceDirectoryChecks = 0;
  let readCalls = 0;
  let closeCalls = 0;

  await assert.rejects(
    inspectContainedRegularFile(
      { candidate, root },
      {
        async lstat(path) {
          if (path === sourceDirectory) {
            sourceDirectoryChecks += 1;
            return {
              isSymbolicLink: () => sourceDirectoryChecks > 1,
            };
          }
          assert.equal(path, candidate);
          return { isSymbolicLink: () => false };
        },
        async open(path) {
          assert.equal(path, candidate);
          return {
            async close() {
              closeCalls += 1;
            },
            async read() {
              readCalls += 1;
              throw new Error("Metadata inspection must not read content.");
            },
            async stat() {
              return fileSnapshot;
            },
          };
        },
        async realpath(path) {
          assert.ok(path === root || path === candidate);
          return path;
        },
        async stat(path) {
          if (path === candidate) {
            return {
              ...fileSnapshot,
              isDirectory: () => false,
            };
          }
          assert.equal(path, root);
          return {
            ...fileSnapshot,
            isDirectory: () => true,
            isFile: () => false,
          };
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof ContainedFileReadError);
      assert.equal(error.failure, "symlink");
      return true;
    },
  );
  assert.equal(sourceDirectoryChecks, 2);
  assert.equal(readCalls, 0);
  assert.equal(closeCalls, 1);
});

test("reports an empty override that masks the canonical file without consuming budget", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    await writeFile(join(consumerRoot, "src", "AGENTS.md"), "# Hidden\n", "utf8");
    await writeFile(join(consumerRoot, "src", "AGENTS.override.md"), " \n\t", "utf8");

    const { result, report } = runInstructions(consumerRoot, "src/index.ts");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.layers[1].status, "ignored-empty");
    assert.equal(report.layers[1].loadedBytes, 0);
    assert.deepEqual(report.layers[1].shadowed.map(({ path }) => path), [
      "src/AGENTS.md",
    ]);
    assert.deepEqual(report.layers[1].canOverrideEarlier, []);
  });
});

test(
  "does not open an unreadable shadowed instruction candidate",
  { skip: process.platform === "win32" },
  async () => {
    await withAgentWorkflowFixture(async (consumerRoot) => {
      const shadowedPath = join(consumerRoot, "src", "AGENTS.md");
      await writeFile(shadowedPath, "# Hidden\n", "utf8");
      await chmod(shadowedPath, 0o000);
      await writeFile(
        join(consumerRoot, "src", "AGENTS.override.md"),
        "# Selected\n",
        "utf8",
      );

      const { result, report } = runInstructions(consumerRoot, "src/index.ts");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(report.layers[1].status, "applied");
      assert.deepEqual(report.layers[1].shadowed.map(({ path }) => path), [
        "src/AGENTS.md",
      ]);
    });
  },
);

test("shows truncation and later exclusions at the default instruction byte budget", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    await mkdir(join(consumerRoot, "src", "nested"));
    await writeFile(join(consumerRoot, "AGENTS.md"), "r".repeat(32_760), "utf8");
    await writeFile(join(consumerRoot, "src", "AGENTS.md"), "s".repeat(20), "utf8");
    await writeFile(
      join(consumerRoot, "src", "nested", "AGENTS.md"),
      "n".repeat(300_000),
      "utf8",
    );

    const { result, report } = runInstructions(
      consumerRoot,
      "src/nested/planned-file.ts",
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(report.budget, {
      maximumBytes: 32_768,
      loadedBytes: 32_768,
      exhausted: true,
      truncated: true,
    });
    assert.deepEqual(report.layers.map(({ status, loadedBytes }) => ({
      status,
      loadedBytes,
    })), [
      { status: "applied", loadedBytes: 32_760 },
      { status: "truncated", loadedBytes: 8 },
      { status: "budget-exhausted", loadedBytes: 0 },
    ]);
    assert.equal(report.layers[2].sourceBytes, 300_000);
    assert.equal(report.layers[2].sourceDigest, null);

    await writeFile(
      join(consumerRoot, "src", "AGENTS.md"),
      `${"s".repeat(8)}${"changed-after-budget".repeat(4)}`,
      "utf8",
    );
    const beyondBudgetChanged = runInstructions(
      consumerRoot,
      "src/nested/planned-file.ts",
    ).report;
    assert.equal(beyondBudgetChanged.resolutionDigest, report.resolutionDigest);
    assert.notEqual(
      beyondBudgetChanged.layers[1].sourceDigest,
      report.layers[1].sourceDigest,
    );
  });
});

test("rejects unsafe effective-instruction targets and selected symlinks", async () => {
  await withAgentWorkflowFixture(async (consumerRoot) => {
    const escaped = runInstructions(consumerRoot, "../outside.ts");
    assert.equal(escaped.result.status, 2);
    assert.equal(escaped.report.error.code, "CONFIG_PATH_INVALID");

    const changedOnlyOption = runInstructions(
      consumerRoot,
      "src/index.ts",
      "json",
      "--base",
      "HEAD",
    );
    assert.equal(changedOnlyOption.result.status, 2);
    assert.equal(changedOnlyOption.report.error.code, "CONSUMER_INVALID");
    assert.match(changedOnlyOption.report.error.message, /only by agent-workflow changed/u);

    const injected = runInstructions(consumerRoot, "src/evil\n\u001b[31m.ts");
    assert.equal(injected.result.status, 2);
    assert.equal(
      injected.report.error.code,
      "REPOSITORY_AGENT_WORKFLOW_TARGET_PATH_INVALID",
    );

    const reader = new FilesystemEffectiveInstructionsReader(instructionObservation);
    const unavailableRoot = join(consumerRoot, "does-not-exist");
    const unsafeDisplayCharacters = [
      ["NUL", "\u0000"],
      ["newline", "\n"],
      ["carriage return", "\r"],
      ["ANSI escape", "\u001b"],
      ["DEL", "\u007f"],
      ["C1 next line", "\u0085"],
      ["C1 control sequence introducer", "\u009b"],
      ["Unicode line separator", "\u2028"],
      ["Unicode paragraph separator", "\u2029"],
      ["lone high surrogate", "\ud800"],
      ["lone low surrogate", "\udc00"],
      ...[
        0x061c,
        0x200e,
        0x200f,
        0x202a,
        0x202b,
        0x202c,
        0x202d,
        0x202e,
        0x2066,
        0x2067,
        0x2068,
        0x2069,
      ].map((codePoint) => [
        `bidirectional control U+${codePoint.toString(16).toUpperCase()}`,
        String.fromCodePoint(codePoint),
      ]),
    ];
    for (const [name, character] of unsafeDisplayCharacters) {
      await assert.rejects(
        reader.discover({
          consumerRoot: unavailableRoot,
          targetPath: `src/${character}spoofed.ts`,
        }),
        (error) => {
          assert.equal(
            error.problem?.code,
            "REPOSITORY_AGENT_WORKFLOW_TARGET_PATH_INVALID",
            name,
          );
          assert.doesNotMatch(error.message, /spoofed/u, name);
          return true;
        },
      );
    }

    await assert.rejects(
      reader.discover({
        consumerRoot: unavailableRoot,
        targetPath: "C:/planned.ts",
      }),
      (error) => {
        assert.equal(
          error.problem?.code,
          "REPOSITORY_AGENT_WORKFLOW_TARGET_PATH_INVALID",
        );
        assert.doesNotMatch(error.message, /planned/u);
        return true;
      },
    );

    const directory = runInstructions(consumerRoot, "src");
    assert.equal(directory.result.status, 2);
    assert.equal(
      directory.report.error.code,
      "REPOSITORY_AGENT_WORKFLOW_TARGET_INVALID",
    );

    const missingTarget = runAgentWorkflowRaw(
      "instructions",
      "--consumer",
      unavailableRoot,
    );
    assert.equal(missingTarget.result.status, 2);
    assert.match(
      missingTarget.report.error.message,
      /requires exactly one repository-relative file/u,
    );
    const extraTarget = runAgentWorkflowRaw(
      "instructions",
      "src/index.ts",
      "src/other.ts",
      "--consumer",
      unavailableRoot,
    );
    assert.equal(extraTarget.result.status, 2);
    assert.match(
      extraTarget.report.error.message,
      /accepts at most 2 positional arguments/u,
    );
    const extraChangedTarget = runAgentWorkflowRaw(
      "changed",
      "src/index.ts",
      "--consumer",
      unavailableRoot,
    );
    assert.equal(extraChangedTarget.result.status, 2);
    assert.match(extraChangedTarget.report.error.message, /does not accept a target path/u);

    if (process.platform !== "win32") {
      await symlink("../AGENTS.md", join(consumerRoot, "src", "AGENTS.override.md"));
      const linked = runInstructions(consumerRoot, "src/index.ts");
      assert.equal(linked.result.status, 2);
      assert.equal(
        linked.report.error.code,
        "REPOSITORY_AGENT_WORKFLOW_INSTRUCTION_SYMLINK_PROHIBITED",
      );
    }
  });
});
