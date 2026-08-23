import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DOCS_PROTOCOL_CLI_COMMAND,
  DOCS_PROTOCOL_PACKAGE_NAME,
  LEGACY_DOCS_CLI_DEPRECATION_CODE,
  emitLegacyDocsCliDeprecation,
  isLegacyDocsCliInvocation,
  renderLegacyDocsCliDeprecation,
} from "../packages/engineering-foundation/dist/legacy-docs-cli-deprecation.js";

const cliPath = fileURLToPath(
  new URL(
    "../packages/engineering-foundation/dist/cli.js",
    import.meta.url,
  ),
);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("renders a stable legacy Docs CLI deprecation signal", () => {
  assert.equal(renderLegacyDocsCliDeprecation(["check"]), undefined);
  assert.equal(
    renderLegacyDocsCliDeprecation(["docs", "find"]),
    `${LEGACY_DOCS_CLI_DEPRECATION_CODE}: agent-teams-foundation docs is deprecated and frozen for compatibility. Use ${DOCS_PROTOCOL_CLI_COMMAND} from ${DOCS_PROTOCOL_PACKAGE_NAME}.\n`,
  );
  assert.equal(
    renderLegacyDocsCliDeprecation(["docs", "find", "--format", "json"]),
    undefined,
  );
  assert.equal(
    renderLegacyDocsCliDeprecation(["docs", "find", "--json"]),
    undefined,
  );
  assert.match(
    renderLegacyDocsCliDeprecation(
      ["docs", "find", "--", "--json"],
      false,
    ),
    /^FOUNDATION_DOCS_CLI_DEPRECATED:/u,
  );
  assert.match(
    renderLegacyDocsCliDeprecation(
      ["docs", "find", "--", "--format", "json"],
      false,
    ),
    /^FOUNDATION_DOCS_CLI_DEPRECATED:/u,
  );
});

test("classifies only the top-level legacy namespace", () => {
  for (const rawArguments of [
    ["docs"],
    ["docs", "find"],
    ["docs", "new"],
    ["docs", "doctor"],
    ["docs", "recover"],
    ["docs.find"],
    ["docs.new"],
    ["docs.doctor"],
    ["docs.recover"],
  ]) {
    assert.equal(isLegacyDocsCliInvocation(rawArguments), true);
  }
  for (const rawArguments of [
    [],
    ["--help"],
    ["check", "docs"],
    ["repo", "check", "docs"],
    ["agent-workflow", "instructions", "docs"],
  ]) {
    assert.equal(isLegacyDocsCliInvocation(rawArguments), false);
    assert.equal(renderLegacyDocsCliDeprecation(rawArguments), undefined);
  }
});

test("emits exactly one human diagnostic and stays silent in machine mode", () => {
  for (const command of ["find", "new", "doctor", "recover"]) {
    const writes = [];
    emitLegacyDocsCliDeprecation(["docs", command], {
      write(notice) {
        writes.push(notice);
      },
    });
    assert.deepEqual(writes, [
      `${LEGACY_DOCS_CLI_DEPRECATION_CODE}: agent-teams-foundation docs is deprecated and frozen for compatibility. Use ${DOCS_PROTOCOL_CLI_COMMAND} from ${DOCS_PROTOCOL_PACKAGE_NAME}.\n`,
    ]);
  }

  for (const rawArguments of [
    ["docs", "find", "--json"],
    ["docs", "new", "--format", "json"],
    ["check", "--format", "json"],
  ]) {
    const writes = [];
    emitLegacyDocsCliDeprecation(rawArguments, {
      write(notice) {
        writes.push(notice);
      },
    });
    assert.deepEqual(writes, []);
  }

  const terminatedWrites = [];
  emitLegacyDocsCliDeprecation(
    ["docs", "find", "--", "--json"],
    {
      machineOutput: false,
      write(notice) {
        terminatedWrites.push(notice);
      },
    },
  );
  assert.equal(terminatedWrites.length, 1);
  assert.match(
    terminatedWrites[0],
    /^FOUNDATION_DOCS_CLI_DEPRECATED:/u,
  );
});

test("keeps text format on the human deprecation path", () => {
  const warning = renderLegacyDocsCliDeprecation([
    "docs", "find", "--format", "text",
  ]);
  assert.match(warning, /^FOUNDATION_DOCS_CLI_DEPRECATED:/u);
  assert.match(warning, /agent-teams-docs/u);
  assert.match(warning, /@agent-teams\/docs-protocol/u);
});

test("advertises Docs Protocol ownership while keeping legacy help visible", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(
    result.stdout,
    /\[DEPRECATED\] agent-teams-foundation docs <command> \[\.\.\.\]/u,
  );
  assert.match(
    result.stdout,
    /Use agent-teams-docs from @agent-teams\/docs-protocol\./u,
  );
});

test("preserves the legacy JSON stream contract while keeping execution available", () => {
  for (const rawArguments of [
    ["docs", "unknown", "--json"],
    ["docs", "--", "--json"],
  ]) {
    const result = spawnSync(process.execPath, [cliPath, ...rawArguments], {
      encoding: "utf8",
    });

    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stderr, "");
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.schemaVersion, 2);
    assert.equal(envelope.command, "docs.doctor");
    assert.equal(envelope.outcome, "invalid-input");
  }
});

test("emits the stable human notice before a legacy invocation error", () => {
  for (const rawArguments of [
    ["docs", "unknown"],
    ["docs.new"],
  ]) {
    const result = spawnSync(process.execPath, [cliPath, ...rawArguments], {
      encoding: "utf8",
    });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`^${LEGACY_DOCS_CLI_DEPRECATION_CODE}:`, "u"));
    assert.match(result.stderr, /CONSUMER_INVALID:/u);
  }
});

async function waitForFile(path) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

test("ignores the package-manager argument separator", () => {
  const result = spawnSync(process.execPath, [cliPath, "attach", "--"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /^CONSUMER_INVALID: attach requires a foundation repository or package path\./u,
  );
});

test("uses the stable invalid-invocation exit code", () => {
  for (const commandArguments of [
    ["check", "--format", "xml"],
    ["check", "workspace.dependency-declarations", "extra"],
    ["check", "--write"],
    ["check", "--buf-executable", process.execPath],
    ["check", "--unknown-option"],
    ["protobuf-qualify-breaking"],
    ["unknown-command"],
  ]) {
    const result = spawnSync(process.execPath, [cliPath, ...commandArguments], {
      encoding: "utf8",
    });

    assert.equal(
      result.status,
      2,
      `${commandArguments.join(" ")}: ${result.stderr}`,
    );
    assert.match(result.stderr, /^CONSUMER_INVALID:/u);
  }
});

test("renders every requested JSON invocation failure as one JSON envelope", () => {
  for (const commandArguments of [
    ["check", "--format", "json", "--unknown-option"],
    ["explain", "missing.rule", "--json"],
    ["schema", "missing/v1", "--format", "json"],
    ["unknown-command", "--json"],
  ]) {
    const result = spawnSync(process.execPath, [cliPath, ...commandArguments], {
      encoding: "utf8",
    });

    assert.equal(result.status, 2, commandArguments.join(" "));
    assert.equal(result.stderr, "");
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.outcome, "invalid-input");
    assert.equal(typeof envelope.error.code, "string");
    assert.equal(typeof envelope.error.message, "string");
    assert.equal(envelope.error.retryable, false);
  }
});

test("accepts the canonical repo check namespace", () => {
  const direct = spawnSync(process.execPath, [
    cliPath, "check", "--consumer", "/definitely-missing-foundation-consumer",
    "--format", "json",
  ], { encoding: "utf8" });
  const namespaced = spawnSync(process.execPath, [
    cliPath, "repo", "check", "--consumer", "/definitely-missing-foundation-consumer",
    "--format", "json",
  ], { encoding: "utf8" });

  assert.equal(namespaced.status, direct.status);
  assert.equal(namespaced.stdout, direct.stdout);
  assert.equal(namespaced.stderr, direct.stderr);
});

test("SIGTERM cancels Buf qualification with exit code 130", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-cli-cancellation-"));
  const fakeBuf = join(root, "fake-buf");
  const marker = `${fakeBuf}.started`;
  const bufConfig = "version: v2\nmodules:\n  - path: .\nbreaking:\n  use:\n    - FILE\n";
  const descriptor = Buffer.from("released descriptor\n", "utf8");
  const generatedDigest = sha256("generated");
  try {
    await mkdir(join(root, "architecture", "contracts"), { recursive: true });
    await writeFile(fakeBuf, '#!/bin/sh\ntouch "$0.started"\nsleep 30\n', "utf8");
    await chmod(fakeBuf, 0o755);
    await writeFile(join(root, "buf.yaml"), bufConfig, "utf8");
    await writeFile(join(root, "architecture", "contracts", "released.binpb"), descriptor);
    await writeFile(join(root, "foundation.config.yaml"), JSON.stringify({
      schemaVersion: 1,
      project: { id: "cli-cancellation" },
      capabilities: {
        "contract.protobuf-evolution": { configPath: "contract.yaml" },
      },
    }), "utf8");
    await writeFile(join(root, "architecture", "contracts", "released.json"), JSON.stringify({
      schemaVersion: 1,
      contractId: "cli-cancellation.control",
      publicContractVersion: "1.0.0",
      bufVersion: "1.72.0",
      bufConfigDigest: sha256(bufConfig),
      descriptorImageDigest: sha256(descriptor),
      generatorVersions: [],
      generatedOutputDigest: generatedDigest,
    }), "utf8");
    await writeFile(join(root, "contract.yaml"), JSON.stringify({
      schemaVersion: 1,
      releasedBaselinePath: "architecture/contracts/released.json",
      approvedBreakingChanges: [],
      qualification: {
        modulePath: ".",
        bufConfigPath: "buf.yaml",
        releasedDescriptorImagePath: "architecture/contracts/released.binpb",
        evidencePath: "architecture/evidence/protobuf/qualification.json",
      },
      current: {
        schemaVersion: 1,
        contractId: "cli-cancellation.control",
        publicContractVersion: "1.0.0",
        bufVersion: "1.72.0",
        bufConfigDigest: sha256(bufConfig),
        descriptorImageDigest: sha256(descriptor),
        generatorVersions: [],
        generationDrift: {
          expectedGeneratedOutputDigest: generatedDigest,
          observedGeneratedOutputDigest: generatedDigest,
        },
      },
    }), "utf8");

    const child = spawn(process.execPath, [
      cliPath,
      "protobuf-qualify-breaking",
      "--consumer",
      root,
      "--buf-executable",
      fakeBuf,
      "--write",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    await waitForFile(marker);
    child.kill("SIGTERM");
    const result = await new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(result, { code: 130, signal: null });
    assert.match(stderr, /^EXECUTION_CANCELLED:/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
