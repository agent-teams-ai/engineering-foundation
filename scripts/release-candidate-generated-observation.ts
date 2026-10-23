import { isDeepStrictEqual } from "node:util";
import type {
  ExpectedInputs,
  FileChange,
  JsonRecord,
  ObservedCandidate,
  ObservedConsumption,
  ReleaseIntent,
} from "../packages/release-checks/dist/index.js";
import {
  readReleaseGitFile,
  releaseJsonDigest,
  releaseObject,
  releaseTreeDigest,
  requireReleaseFile,
  type ChangesetsInstallation,
  type ReleaseGitAuthority,
  type ReleaseTree,
} from "./release-candidate-observation.ts";
import {
  inventory,
  inventoryDigest,
  permittedChanges,
  snapshot,
  sourceIntents,
  stateAt,
  type ReadReleaseFile,
} from "./release-candidate-source-facts.ts";

function fail(message: string): never {
  throw new Error(`Release candidate rejected: ${message}`);
}

function observedConsumptions(
  beforePre: JsonRecord | undefined,
  afterPre: JsonRecord | undefined,
  intents: readonly ReleaseIntent[],
  afterTree: ReleaseTree,
): readonly ObservedConsumption[] {
  const consumptions: ObservedConsumption[] = [];
  const recordedBefore = new Set(
    Array.isArray(beforePre?.["changesets"]) ? beforePre["changesets"] : [],
  );
  const recordedAfter = new Set(
    Array.isArray(afterPre?.["changesets"]) ? afterPre["changesets"] : [],
  );
  for (const id of recordedAfter) {
    if (!recordedBefore.has(id) && !intents.some((intent) => intent.id === id)) {
      fail("prerelease metadata recorded an unknown source intent.");
    }
  }
  for (const intent of intents) {
    if (!afterTree.has(intent.path)) {
      consumptions.push({ intentId: intent.id, digest: intent.digest, effect: { kind: "remove" } });
    } else if (recordedAfter.has(intent.id) && !recordedBefore.has(intent.id)) {
      consumptions.push({
        intentId: intent.id,
        digest: intent.digest,
        effect: { kind: "record", evidencePath: ".changeset/pre.json" },
      });
    }
  }
  return consumptions;
}

export async function observeCandidate({
  authority,
  sourceIdentity,
  expected,
  beforeTree,
  afterTree,
  readAfter,
  candidateIdentity,
  installation,
}: {
  readonly authority: ReleaseGitAuthority;
  readonly sourceIdentity: string;
  readonly expected: ExpectedInputs;
  readonly beforeTree: ReleaseTree;
  readonly afterTree: ReleaseTree;
  readonly readAfter: ReadReleaseFile;
  readonly candidateIdentity: string;
  readonly installation: ChangesetsInstallation;
}): Promise<ObservedCandidate> {
  const readBefore = (path: string) => readReleaseGitFile(authority, beforeTree, path);
  const configFile = await requireReleaseFile(readAfter, ".changeset/config.json");
  const config = releaseObject(configFile.bytes, ".changeset/config.json");
  const afterPackages = await inventory(afterTree, readAfter, config);
  const beforePre = await stateAt(readBefore);
  const afterPre = await stateAt(readAfter);
  const rawIntents = await sourceIntents(beforeTree, readBefore, beforePre);
  const manifests = [];
  for (const path of [
    ...new Set([
      ...expected.packages.map((pkg) => pkg.manifestPath),
      ...afterPackages.map((pkg) => pkg.manifestPath),
    ]),
  ].toSorted()) {
    manifests.push({
      manifestPath: path,
      before: snapshot(await readBefore(path), path),
      after: snapshot(await readAfter(path), path),
    });
  }
  const diff: FileChange[] = [];
  for (const path of [...new Set([...beforeTree.keys(), ...afterTree.keys()])].toSorted()) {
    if (isDeepStrictEqual(beforeTree.get(path), afterTree.get(path))) {
      continue;
    }
    const before = await readBefore(path);
    const after = await readAfter(path);
    const classification =
      expected.permittedChanges.find((change) => change.path === path)?.classification ??
      "unclassified";
    diff.push({
      path,
      classification,
      kind: before === null ? "added" : after === null ? "deleted" : "modified",
      before: before?.file ?? null,
      after: after?.file ?? null,
    });
  }
  const consumptions = observedConsumptions(beforePre, afterPre, rawIntents, afterTree);
  return {
    candidateIdentity,
    manifests,
    diff,
    consumptions,
    binding: {
      source: {
        repository: "agent-teams-ai/engineering-foundation",
        identity: sourceIdentity,
        digest: releaseTreeDigest(beforeTree),
      },
      engine: {
        name: installation.name,
        version: installation.version,
        digest: installation.digest,
      },
      configDigest: configFile.file.digest,
      inventoryDigest: inventoryDigest(afterPackages),
      policyDigest: releaseJsonDigest(
        await permittedChanges(beforeTree, readBefore, expected.packages, rawIntents, beforePre),
      ),
      intentsDigest: releaseJsonDigest(rawIntents),
      planDigest: releaseJsonDigest(expected.plan),
    },
  };
}
