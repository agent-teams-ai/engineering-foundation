import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(
  new URL(
    "../packages/engineering-foundation/dist/cli.js",
    import.meta.url,
  ),
);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

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
