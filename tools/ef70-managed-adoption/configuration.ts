import assert from "node:assert/strict";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  initializeCampaignRoots,
  observationChildEnvironment,
  ownedDirectory,
} from "../ef70-managed-campaign/owned-root.ts";
import { absolute, regularImage, siblingRoots, text } from "./files.ts";

export const sourceCohort = "docs-2026-10-03-stable31";
export const packageReferenceCohort = "docs-2026-11-27-stable35";
export const producerM = "1b753d04847c1021dd5a485383c4df0714b27be7";
export const producerBase = "7438b7ee4429dc7798cf2b18c81e6bc7788f0f5b";
export const parentHarness = "00f3c8560c7b1f57657b9149d0fa4fad7b662760";
export interface AdoptionConfig {
  readonly roots: ReturnType<typeof initializeCampaignRoots>;
  readonly harness: string;
  readonly consumer: string;
  readonly central: string;
  readonly harnessRevision: string;
  readonly sourceRevision: string;
  readonly authorityRevision: string;
  readonly targetCohort: string;
  readonly preflightRunId: string;
  readonly node24: string;
  readonly node26: string;
  readonly npmEntrypoint: string;
  readonly environment: NodeJS.ProcessEnv;
}
export function gitSha(value: unknown, label: string): string {
  const sha = text(value, label);
  assert(/^(?!0{40}$)[0-9a-f]{40}$/u.test(sha), label);
  return sha;
}
export function cohortId(value: unknown): string {
  const cohort = text(value, "target cohort");
  assert(cohort.length <= 128);
  assert(/^docs-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*$/u.test(cohort));
  assert(
    cohort !== packageReferenceCohort && cohort !== sourceCohort,
    "Select a genuinely new cohort",
  );
  return cohort;
}
function required(name: string): string {
  return text(process.env[name], name);
}
function configureEnvironment(
  roots: AdoptionConfig["roots"],
  node24: string,
  node26: string,
  harness: string,
): NodeJS.ProcessEnv {
  const root = roots.root;
  const environment = observationChildEnvironment(process.env);
  for (const key of [
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "NPM_TOKEN",
    "NPM_AUTH_TOKEN",
  ]) {
    delete environment[key];
  }
  assert.equal(environment["NODE_OPTIONS"], undefined, "No ambient Node preload/options");
  assert.equal(environment["NODE_PATH"], undefined, "No ambient Node module path");
  for (const leaf of ["corepack-cache", "pnpm-store", "npm-cache", "tmp"]) {
    mkdirSync(join(root, leaf), { mode: 0o700 });
  }
  return {
    ...environment,
    PATH: dirname(node26) + ":" + required("PATH"),
    AGENT_TEAMS_DOCS_UPGRADE_NODE24_EXECUTABLE: node24,
    AGENT_TEAMS_DOCS_UPGRADE_NODE26_EXECUTABLE: node26,
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
    EF70_COMPILER_GUARD_LOG: join(roots.evidenceRoot, "runtime-guard.jsonl"),
    PNPM_MAX_WORKERS: "1",
    GOMAXPROCS: "2",
    RAYON_NUM_THREADS: "2",
  };
}
export function configuration(): AdoptionConfig {
  assert.equal(process.argv.length, 2, "Finite canonical adoption accepts no operation selector");
  assert.equal(process.versions.node, "26.12.1");
  assert(
    availableParallelism() >= 1 && availableParallelism() <= 2,
    "Select real own CPU affinity",
  );
  const harness = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const consumer = absolute(required("EF70_ADOPTION_CONSUMER_ROOT"), "consumer root");
  const central = absolute(required("EF70_ADOPTION_CENTRAL_ROOT"), "central root");
  const node24 = realpathSync(absolute(required("EF70_NODE24_EXECUTABLE"), "Node24"));
  const node26 = realpathSync(absolute(required("EF70_NODE26_EXECUTABLE"), "Node26"));
  assert.equal(node26, realpathSync(process.execPath));
  for (const path of [node24, node26]) {
    assert((regularImage(path, 256 * 1024 * 1024).mode & 0o111) !== 0);
  }
  const npmEntrypoint = join(dirname(dirname(node26)), "lib/node_modules/npm/bin/npm-cli.js");
  assert(lstatSync(npmEntrypoint).isFile());
  const preflightRunId = required("EF70_ADOPTION_PREFLIGHT_RUN_ID");
  assert(/^[1-9][0-9]*$/u.test(preflightRunId));
  const roots = initializeCampaignRoots();
  siblingRoots([harness, consumer, central, roots.root, roots.evidenceRoot]);
  ownedDirectory(roots.evidenceRoot);
  mkdirSync(join(roots.evidenceRoot, "bootstrap"), { mode: 0o700 });
  mkdirSync(join(roots.evidenceRoot, "case-canonical"), { mode: 0o700 });
  const config = {
    roots,
    harness,
    consumer,
    central,
    node24,
    node26,
    npmEntrypoint,
    preflightRunId,
    harnessRevision: gitSha(required("EF70_ADOPTION_HARNESS_REVISION"), "harness revision"),
    sourceRevision: gitSha(required("GITHUB_SHA"), "actual EF push revision"),
    authorityRevision: gitSha(required("EF70_ADOPTION_AUTHORITY_REVISION"), "authority revision"),
    targetCohort: cohortId(required("EF70_ADOPTION_COHORT")),
    environment: configureEnvironment(roots, node24, node26, harness),
  };
  assert.equal(
    required("EF70_HARNESS_REVISION"),
    config.harnessRevision,
    "Reporter alias matches actual harness",
  );
  return config;
}
