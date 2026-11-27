import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { assertManagedSuccessorProfileV4 } from "../../../dist/consumer-integration/application-api.js";
import { digestBytes } from "../../../dist/consumer-integration/application/policies/consumer-integration-assets.js";
import type { ConsumerIntegrationSnapshot } from "../../../dist/consumer-integration/domain/model.js";
import { desired, file } from "../../consumer-plan-v3-fixture.ts";
import { currentSnapshot, selected, target } from "../../consumer-upgrade-generation3-fixture.ts";
import { lockfileObjectForV2, runGit } from "../../consumer-upgrade-e2e-fixtures.mjs";
import { candidate, expected, packages } from "./consumer-target-lockfile-fixture.mjs";

export function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

export function at(value: unknown, ...keys: readonly string[]): Record<string, unknown> {
  return keys.reduce<Record<string, unknown>>((entry, key) => record(entry[key]), record(value));
}

export const encoded = (value: unknown): Buffer =>
  Buffer.from("# consumer-owned Node types and retained foreign tool\n" + JSON.stringify(value) + "\n");

export function managedTargetLockFixture() {
  const current = desired();
  const base = target();
  const successor = {
    ...base,
    cohort: {
      ...base.cohort,
      packages,
      runtime: {
        ...base.cohort.runtime,
        runtimeClosure: { domain: "agent-teams.docs-runtime-closure/v2", digest: expected },
      },
    },
  };
  assertManagedSuccessorProfileV4(successor);
  const before = record(lockfileObjectForV2(current.cohort));
  const after = record(parse(candidate.toString("utf8")));
  const integrity = current.cohort.packages.docsProtocol.integrity;
  const foreignPackages = {
    "@types/node@24.13.3": { resolution: { integrity } },
    "undici-types@7.18.2": { resolution: { integrity } },
    "foreign-tool@1.0.0": { resolution: { integrity } },
    "fast-uri@3.1.7": at(after, "packages")["fast-uri@3.1.7"],
  };
  const foreignSnapshots = {
    "@types/node@24.13.3": { dependencies: { "undici-types": "7.18.2" } },
    "undici-types@7.18.2": {},
    "foreign-tool@1.0.0": { dependencies: { "fast-uri": "3.1.7" } },
    "fast-uri@3.1.7": at(after, "snapshots")["fast-uri@3.1.7"],
  };
  for (const value of [before, after]) {
    Object.assign(at(value, "importers", ".", "devDependencies"), {
      "@types/node": { specifier: "24.13.3", version: "24.13.3" },
      "foreign-tool": { specifier: "1.0.0", version: "1.0.0" },
    });
    at(value, "importers")["packages/host"] = {
      devDependencies: { "@types/node": { specifier: "24.13.3", version: "24.13.3" } },
    };
    Object.assign(at(value, "packages"), structuredClone(foreignPackages));
    Object.assign(at(value, "snapshots"), structuredClone(foreignSnapshots));
  }
  return {
    current, successor, before, after,
    beforeBytes: encoded(before), selectedBytes: encoded(after),
  };
}

function sourceSnapshot(current: ReturnType<typeof desired>, beforeBytes: Buffer) {
  const initial = currentSnapshot(current);
  assert.equal(initial.packageManifest.state, "file");
  const manifest = record(
    JSON.parse(Buffer.from(initial.packageManifest.bytes).toString("utf8")),
  );
  Object.assign(at(manifest, "devDependencies"), {
    "@types/node": "24.13.3", "foreign-tool": "1.0.0",
  });
  return {
    ...initial,
    lockfile: file(beforeBytes),
    packageManifest: file(JSON.stringify(manifest)),
  };
}

async function seedSourceFiles(
  consumer: string,
  current: ReturnType<typeof desired>,
  snapshot: ConsumerIntegrationSnapshot,
) {
  const paths: Record<keyof ConsumerIntegrationSnapshot, string> = {
    integrationProfile: "architecture/foundation/docs-consumer-integration.json",
    packageManifest: "package.json",
    lockfile: "pnpm-lock.yaml",
    agents: "AGENTS.md",
    skill: current.skillPath,
    callerWorkflow: current.callerWorkflowPath,
    managedState: current.managedStatePath,
  };
  for (const key of Object.keys(paths) as (keyof ConsumerIntegrationSnapshot)[]) {
    const observation = snapshot[key];
    assert.equal(observation.state, "file");
    const path = join(consumer, paths[key]);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, observation.bytes, { mode: observation.mode });
  }
  await writeFile(join(consumer, ".node-version"), "26.12.1\n");
  await writeFile(join(consumer, ".gitignore"), "node_modules/\n");
  await writeFile(join(consumer, "pnpm-workspace.yaml"), "packages: ['packages/*']\n");
  await mkdir(join(consumer, "packages/host"), { recursive: true });
  await writeFile(join(consumer, "packages/host/package.json"), JSON.stringify({
    name: "TEST-foreign-host", private: true,
    devDependencies: { "@types/node": "24.13.3" },
  }));
  for (const args of [
    ["init", "-q"], ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "TEST fixture"], ["add", "."],
    ["commit", "-qm", "test: seed managed selected lock"],
  ]) runGit(consumer, args);
  return paths;
}

export async function seedManagedTargetLockSandbox() {
  const fixture = managedTargetLockFixture();
  const { current, beforeBytes } = fixture;
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-managed-target-lock-")));
  const consumer = join(root, "consumer");
  const snapshot = sourceSnapshot(current, beforeBytes);
  const paths = await seedSourceFiles(consumer, current, snapshot);
  const proof = (key: "skill" | "callerWorkflow" | "managedState") => {
    const observation = snapshot[key];
    assert.equal(observation.state, "file");
    return { path: paths[key], mode: observation.mode, digest: digestBytes(observation.bytes) };
  };
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, key] of [
    ["node24", "AGENT_TEAMS_DOCS_UPGRADE_NODE24_EXECUTABLE"],
    ["node26", "AGENT_TEAMS_DOCS_UPGRADE_NODE26_EXECUTABLE"],
    ["corepack", "AGENT_TEAMS_DOCS_UPGRADE_COREPACK_ENTRYPOINT"],
  ] as const) {
    const path = join(root, name);
    await writeFile(path, "inert fixture executable; every call is intercepted\n");
    environment[key] = path;
  }
  return {
    ...fixture, root, consumer, environment, snapshot,
    options: {
      consumerRoot: consumer, current, authority: selected(fixture.successor),
      expectedSourceRevision: runGit(consumer, ["rev-parse", "HEAD"]),
      expectedSourceSnapshot: snapshot,
      managedPreimages: {
        skill: proof("skill"), callerWorkflow: proof("callerWorkflow"),
        managedState: proof("managedState"),
      },
    },
  };
}
