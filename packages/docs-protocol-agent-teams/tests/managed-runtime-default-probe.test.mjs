import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { managedUpgradeRuntime } from "../dist/consumer-integration/adapters/node-consumer-upgrade-runtime.js";
import { setup } from "./managed-runtime-install-fixture.ts";

test(
  `${process.versions.node}: wrong Corepack default is classified before pnpm reads the consumer manifest`,
  async () => {
    const major = Number(process.versions.node.split(".")[0]);
    const lane = major === 26 ? "node26" : "node24";
    assert.ok(major === 24 || major === 26, `Unsupported test Node ${process.versions.node}`);
    assert.equal(process.versions.node, major === 26 ? "26.12.1" : "24.22.3");
  const x = await setup(
    lane,
    `${lane}: wrong Corepack default is classified before pnpm reads the consumer manifest`,
  );
  try {
    const corepack = join(x.f.root, "TEST-neutral-corepack-probe.mjs");
    await writeFile(
      corepack,
      [
        'import { existsSync } from "node:fs";',
        'import { join } from "node:path";',
        'if (existsSync(join(process.cwd(), "package.json"))) {',
        '  console.error("consumer manifest reached the version-only probe");',
        '  process.exit(23);',
        '}',
        'process.stdout.write("11.18.0\\n");',
        "",
      ].join("\n"),
      { mode: 0o600, flag: "wx" },
    );
    await assert.rejects(
      managedUpgradeRuntime(
        { schemaVersion: major === 26 ? 3 : 2 },
        x.root,
        () => ({
          ...process.env,
          [`AGENT_TEAMS_DOCS_UPGRADE_NODE${major}_EXECUTABLE`]: process.execPath,
          AGENT_TEAMS_DOCS_UPGRADE_COREPACK_ENTRYPOINT: corepack,
          COREPACK_ENABLE_PROJECT_SPEC: "0",
          COREPACK_ENABLE_NETWORK: "0",
        }),
        true,
      ),
      (error) =>
        error?.code === "DOCS_CONSUMER_UPGRADE_RUNTIME_INVALID" &&
        /Observed pnpm differs from the exact consumer packageManager pin/u.test(error.message),
    );
    } finally {
      await x.scope.close();
      await x.f.cleanup();
    }
  },
);
