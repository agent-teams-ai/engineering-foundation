import { realpath, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationSnapshot,
  ConsumerIntegrationFileObservation,
  QualifiedDocsCohortBindingV1,
  QualifiedDocsCohortBindingV2,
} from "../../../dist/consumer-integration/index.js";
import { describeCanonicalConsumerAssets } from "../../../dist/consumer-integration/application/policies/consumer-integration-assets.js";
import {
  sourceCohort,
  sourceManifest,
  lockfileFor,
  runGit,
} from "../../consumer-upgrade-e2e-fixtures.mjs";
import { packages, expected, bytes } from "./consumer-target-lockfile-fixture.mjs";
export async function seedTargetLockSandbox(
  desired: (
    cohort: QualifiedDocsCohortBindingV1,
    generation: 1,
  ) => ConsumerIntegrationDesiredStateV1,
  cohortV2: (id: string) => QualifiedDocsCohortBindingV2,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-target-lock-sandbox-")));
  const consumer = join(root, "consumer"),
    path = join(root, "selected.yaml");
  const { cohort } = await sourceCohort();
  const current = desired(cohort as QualifiedDocsCohortBindingV1, 1);
  const target: {
    -readonly [K in keyof QualifiedDocsCohortBindingV2]: QualifiedDocsCohortBindingV2[K];
  } = {
    ...cohortV2("target-lock-test"),
    packages: packages as QualifiedDocsCohortBindingV2["packages"],
    runtime: {
      ...cohort.runtime,
      runtimeClosureDigest: expected,
    } as QualifiedDocsCohortBindingV2["runtime"],
  };
  target.assets = describeCanonicalConsumerAssets(target);
  const sourceFiles: Record<keyof ConsumerIntegrationSnapshot, [string, Buffer]> = {
    integrationProfile: ["architecture/foundation/docs-consumer-integration.json", bytes(current)],
    packageManifest: ["package.json", bytes(sourceManifest(cohort, current.profilePath))],
    lockfile: ["pnpm-lock.yaml", Buffer.from(lockfileFor(cohort))],
    agents: ["AGENTS.md", Buffer.from("source agents\n")],
    skill: [current.skillPath, Buffer.from("source skill\n")],
    callerWorkflow: [current.callerWorkflowPath, Buffer.from("source workflow\n")],
    managedState: [current.managedStatePath, Buffer.from("source state\n")],
  };
  const snapshot: Partial<
    Record<keyof ConsumerIntegrationSnapshot, ConsumerIntegrationFileObservation>
  > = {};
  for (const [key, [file, content]] of Object.entries(sourceFiles)) {
    await mkdir(dirname(join(consumer, file)), { recursive: true });
    await writeFile(join(consumer, file), content);
    snapshot[key as keyof ConsumerIntegrationSnapshot] = {
      state: "file",
      bytes: content,
      mode: 0o644,
    };
  }
  await writeFile(join(consumer, "pnpm-workspace.yaml"), "packages: []\n");
  runGit(consumer, ["init", "-q"]);
  runGit(consumer, ["config", "user.email", "iliyazelenkog@gmail.com"]);
  runGit(consumer, ["config", "user.name", "iliya"]);
  runGit(consumer, ["add", "."]);
  runGit(consumer, ["commit", "-qm", "test: seed disposable source"]);
  const options = {
    consumerRoot: consumer,
    current,
    expectedSourceSnapshot: snapshot,
    expectedSourceRevision: runGit(consumer, ["rev-parse", "HEAD"]),
    authority: {
      cohort: target,
      repository: "agent-teams-ai/.github",
      path: "governance/docs-qualified-cohorts.json",
      revision: "8".repeat(40),
    },
  };
  return { root, consumer, path, current, target, sourceFiles, snapshot, options };
}
