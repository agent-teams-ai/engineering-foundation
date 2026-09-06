import { basename, dirname } from "node:path";
import { inspectKnownFileTransactionBarrier, sha256Bytes } from "@agent-teams/repository-mutation";
import {
  type ConsumerRestorationIntent,
  type ConsumerRestorationOptions,
  type ConsumerRestorationPreparation,
  MAXIMUM_RESTORATION_PROOF_BYTES,
  parseConsumerRestorationPreparation,
  parseConsumerRestorationProof,
  requireRestoration,
  restorationJson
} from "../application-api.js";

import {
  assertRestorationPlanSource, externalRestorationPath, historicalRestorationProfile,
  restorationArtifacts, restorationConsumer, restorationGit
} from "./node-consumer-restoration-evidence.js";
import { readStableConsumerFile } from "./node-consumer-repository-files.js";

export async function readRestorationEvidence(root: string, path: string, required = true) {
  const selected = await externalRestorationPath(path, root);
  return readStableConsumerFile(dirname(selected), basename(selected), MAXIMUM_RESTORATION_PROOF_BYTES, required);
}

export async function readRestorationPreparation(root: string, path: string, expect: string): Promise<ConsumerRestorationPreparation> {
  const file = await readRestorationEvidence(root, path);
  requireRestoration(file.state === "file", "preparation is missing.");
  return parseConsumerRestorationPreparation(file.bytes, expect);
}

export async function readSelectedRestorationProof(root: string,
  options: Pick<ConsumerRestorationOptions, "proofPath" | "expect">) {
  const file = await readRestorationEvidence(root, options.proofPath);
  requireRestoration(file.state === "file", "proof is missing.");
  const proof = parseConsumerRestorationProof(file.bytes, options.expect);
  const digest = sha256Bytes(file.bytes);
  requireRestoration(proof.proofPath === options.proofPath, "final proof destination differs from the explicit retained path.");
  return { proof, digest };
}

export async function assertRestorationBinding(root: string, proof: ConsumerRestorationIntent) {
  requireRestoration(restorationJson(await restorationConsumer(root, proof.consumer.repository)) === restorationJson(proof.consumer),
    "proof belongs to another consumer.");
  requireRestoration(restorationJson(await restorationArtifacts(root)) === restorationJson({ controller: proof.controller, kernel: proof.kernel }),
    "retain the exact recorded controller and kernel package versions AND builds.");
  requireRestoration((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state === "idle",
    "active transaction requires exact kernel recovery first.");
  const source = await historicalRestorationProfile(root, proof.sourceRevision);
  requireRestoration(restorationJson(source.cohort) === restorationJson(proof.sourceCohort) &&
    restorationJson(source.repository) === restorationJson(proof.consumer.repository) &&
    (await restorationGit(root, ["rev-parse", "HEAD"])).toString().trim() === proof.sourceRevision &&
    (await restorationGit(root, ["rev-parse", `${proof.sourceRevision}^{tree}`])).toString().trim() === proof.sourceTree,
  "historical source binding changed.");
  await assertRestorationPlanSource(root, proof.sourceRevision, source, proof.plan, proof.targetCohort);
  return source;
}
