import assert from "node:assert/strict";
import test from "node:test";

import {
  FoundationError,
  defineFoundationConfig,
  parseFoundationConfig
} from "../packages/engineering-foundation/dist/index.js";

test("accepts a strict capability-owned configuration", () => {
  const config = defineFoundationConfig({
    schemaVersion: 1,
    projectId: "agent-teams-orchestrator",
    projectKind: "service",
    capabilities: {
      architecture: {
        enabled: true,
        configPath: "architecture/package-catalog.yaml"
      },
      lint: { enabled: true }
    }
  });

  assert.equal(config.projectId, "agent-teams-orchestrator");
  assert.equal(config.capabilities.architecture?.enabled, true);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.capabilities), true);
});

test("rejects unknown capabilities and fields", () => {
  assert.throws(
    () =>
      parseFoundationConfig({
        schemaVersion: 1,
        projectId: "consumer",
        projectKind: "service",
        capabilities: {
          invented: { enabled: true }
        }
      }),
    (error) =>
      error instanceof FoundationError && error.code === "CONFIG_INVALID"
  );

  assert.throws(
    () =>
      parseFoundationConfig({
        schemaVersion: 1,
        projectId: "consumer",
        projectKind: "service",
        capabilities: {
          lint: { enabled: true, magic: true }
        }
      }),
    (error) =>
      error instanceof FoundationError && error.code === "CONFIG_INVALID"
  );
});

test("rejects config paths that escape the consumer repository", () => {
  assert.throws(
    () =>
      parseFoundationConfig({
        schemaVersion: 1,
        projectId: "consumer",
        projectKind: "service",
        capabilities: {
          lint: { enabled: true, configPath: "../other/config.json" }
        }
      }),
    (error) =>
      error instanceof FoundationError && error.code === "CONFIG_INVALID"
  );
});
