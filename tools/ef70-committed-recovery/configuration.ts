import assert from "node:assert/strict";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  initializeCampaignRoots,
  observationChildEnvironment,
} from "../ef70-managed-campaign/owned-root.ts";
import { type AdoptionConfig, gitSha } from "../ef70-managed-adoption/configuration.ts";
import { absolute, regularImage, siblingRoots, text } from "../ef70-managed-adoption/files.ts";

export const adoptionHarness = "73c2e6b3faff21f1b9374748501f11edf28f40ec";
export const consumerBranch = "docs/coordinated-module-foundation-20261126";
export interface ArtifactSelection {
  readonly runId: string;
  readonly attempt: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly preparationDigest: string;
}
export interface RecoverySetup extends Omit<AdoptionConfig, "targetCohort"> {
  readonly artifact: ArtifactSelection;
  readonly downloadRoot: string;
}
export interface RecoveryConfig extends RecoverySetup, AdoptionConfig {}
export function positiveId(value: unknown, label: string): string {
  const result = text(value, label);
  assert(/^[1-9][0-9]*$/u.test(result) && Number.isSafeInteger(Number(result)), label);
  return result;
}
export function digest(value: unknown, label: string): string {
  const result = text(value, label);
  assert(/^sha256:[0-9a-f]{64}$/u.test(result), label);
  return result;
}
function required(name: string): string {
  return text(process.env[name], name);
}
function environment(
  root: string,
  evidence: string,
  harness: string,
  nodes: readonly [string, string],
): NodeJS.ProcessEnv {
  const env = observationChildEnvironment(process.env);
  for (const key of [
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "NPM_TOKEN",
    "NPM_AUTH_TOKEN",
  ]) {
    delete env[key];
  }
  assert.equal(env["NODE_OPTIONS"], undefined);
  assert.equal(env["NODE_PATH"], undefined);
  for (const leaf of ["corepack-cache", "pnpm-store", "npm-cache", "tmp"]) {
    mkdirSync(join(root, leaf), { mode: 0o700 });
  }
  return {
    ...env,
    PATH: dirname(nodes[1]) + ":" + required("PATH"),
    AGENT_TEAMS_DOCS_UPGRADE_NODE24_EXECUTABLE: nodes[0],
    AGENT_TEAMS_DOCS_UPGRADE_NODE26_EXECUTABLE: nodes[1],
    COREPACK_HOME: join(root, "corepack-cache"),
    pnpm_config_store_dir: join(root, "pnpm-store"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: "/dev/null",
    TMPDIR: join(root, "tmp"),
    NODE_OPTIONS:
      "--import=" +
      pathToFileURL(join(harness, "tools/ef70-managed-campaign/compiler-guard.ts")).href,
    EF70_COMPILER_GUARD_LOG: join(evidence, "runtime-guard.jsonl"),
    PNPM_MAX_WORKERS: "1",
    GOMAXPROCS: "2",
    RAYON_NUM_THREADS: "2",
  };
}
export function configuration(): RecoverySetup {
  assert.equal(process.argv.length, 2, "One finite current recovery; no operation selector");
  assert.equal(process.versions.node, "26.12.1");
  assert(availableParallelism() >= 1 && availableParallelism() <= 2);
  const harness = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const consumer = absolute(required("EF70_RECOVERY_CONSUMER_ROOT"), "consumer root");
  const central = absolute(required("EF70_RECOVERY_CENTRAL_ROOT"), "central root");
  const node24 = realpathSync(absolute(required("EF70_NODE24_EXECUTABLE"), "Node24"));
  const node26 = realpathSync(absolute(required("EF70_NODE26_EXECUTABLE"), "Node26"));
  assert.equal(node26, realpathSync(process.execPath));
  for (const path of [node24, node26]) {
    assert((regularImage(path, 256 * 1024 * 1024).mode & 0o111) !== 0);
  }
  const npmEntrypoint = join(dirname(dirname(node26)), "lib/node_modules/npm/bin/npm-cli.js");
  assert(lstatSync(npmEntrypoint).isFile());
  const roots = initializeCampaignRoots();
  const downloadRoot = join(
    realpathSync(required("RUNNER_TEMP")),
    "ef70-adoption-download-" + roots.runId + "-" + roots.runAttempt,
  );
  siblingRoots([harness, consumer, central, roots.root, roots.evidenceRoot, downloadRoot]);
  for (const name of ["bootstrap", "case-canonical", "intake"]) {
    mkdirSync(join(roots.evidenceRoot, name), { mode: 0o700 });
  }
  const result = {
    roots,
    harness,
    consumer,
    central,
    node24,
    node26,
    npmEntrypoint,
    downloadRoot,
    harnessRevision: gitSha(required("EF70_RECOVERY_HARNESS_REVISION"), "H3 revision"),
    sourceRevision: gitSha(required("GITHUB_SHA"), "actual final EF revision"),
    authorityRevision: gitSha(required("EF70_RECOVERY_AUTHORITY_REVISION"), "current authority"),
    preflightRunId: positiveId(required("EF70_RECOVERY_PREFLIGHT_RUN_ID"), "H3 preflight"),
    artifact: {
      runId: positiveId(required("EF70_ADOPTION_RUN_ID"), "adoption run"),
      attempt: positiveId(required("EF70_ADOPTION_RUN_ATTEMPT"), "adoption attempt"),
      artifactId: positiveId(required("EF70_ADOPTION_ARTIFACT_ID"), "adoption artifact"),
      artifactDigest: digest(required("EF70_ADOPTION_ARTIFACT_DIGEST"), "archive digest"),
      preparationDigest: digest(required("EF70_ORIGINAL_PREPARATION_DIGEST"), "original P digest"),
    },
    environment: environment(roots.root, roots.evidenceRoot, harness, [node24, node26]),
  };
  assert.equal(required("EF70_HARNESS_REVISION"), result.harnessRevision);
  return result;
}
