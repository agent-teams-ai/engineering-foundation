import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { syntheticDigest, writeJson } from "./pack-test-support.mjs";

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function writePackedConsumerProtobufFixture(consumerRoot, foundationRoot) {
  const qualificationModel = await import(
    pathToFileURL(
      join(
        foundationRoot,
        "dist",
        "capabilities",
        "contract-protobuf-evolution",
        "application",
        "model",
        "buf-breaking-qualification.js"
      )
    ).href
  );
  const bufConfigSource =
    "version: v2\nmodules:\n  - path: contracts/protobuf\nbreaking:\n  use:\n    - FILE\n";
  const descriptorImage = Buffer.from("packed consumer descriptor image\n", "utf8");
  const released = {
    schemaVersion: 1,
    contractId: "pack-consumer.control",
    publicContractVersion: "1.0.0",
    bufVersion: "1.72.0",
    bufConfigDigest: sha256(bufConfigSource),
    descriptorImageDigest: sha256(descriptorImage),
    generatorVersions: [],
    generatedOutputDigest: syntheticDigest("c")
  };
  await writeJson(
    join(consumerRoot, "architecture", "contracts", "protobuf", "pack-consumer.control.json"),
    released
  );
  await writeFile(join(consumerRoot, "buf.yaml"), bufConfigSource, "utf8");
  await writeFile(
    join(consumerRoot, "architecture", "contracts", "protobuf", "pack-consumer.control.binpb"),
    descriptorImage
  );
  const qualification = {
    modulePath: "contracts/protobuf",
    bufConfigPath: "buf.yaml",
    releasedDescriptorImagePath:
      "architecture/contracts/protobuf/pack-consumer.control.binpb",
    evidencePath: "architecture/evidence/protobuf/pack-consumer.control.json"
  };
  const current = {
    schemaVersion: 1,
    contractId: released.contractId,
    publicContractVersion: released.publicContractVersion,
    bufVersion: released.bufVersion,
    bufConfigDigest: released.bufConfigDigest,
    descriptorImageDigest: released.descriptorImageDigest,
    generatorVersions: [],
    generationDrift: {
      expectedGeneratedOutputDigest: released.generatedOutputDigest,
      observedGeneratedOutputDigest: released.generatedOutputDigest
    }
  };
  const evidenceWithoutDigest = {
    schemaVersion: 1,
    producerId: "agent-teams-foundation.buf-breaking-qualification",
    producerVersion: 1,
    policy: "FILE",
    contractId: current.contractId,
    bufVersion: current.bufVersion,
    modulePath: qualification.modulePath,
    bufConfigPath: qualification.bufConfigPath,
    evidencePath: qualification.evidencePath,
    bufConfigDigest: current.bufConfigDigest,
    baselineDescriptorImagePath: qualification.releasedDescriptorImagePath,
    baselineDescriptorImageDigest: released.descriptorImageDigest,
    candidateDescriptorImageDigest: current.descriptorImageDigest,
    breakingPolicyConfigDigest: sha256(
      qualificationModel.BUF_FILE_BREAKING_CONFIG_SOURCE,
    ),
    invocationDigest: sha256(
      qualificationModel.canonicalBufQualificationInvocation(
        qualificationModel.qualificationInvocationInput({
          qualification,
          current,
          released,
          breakingPolicyConfigDigest: sha256(
            qualificationModel.BUF_FILE_BREAKING_CONFIG_SOURCE,
          )
        })
      )
    ),
    result: {
      status: "compatible",
      findings: [],
      findingSetDigest: sha256(qualificationModel.canonicalBufFindingSet([])),
      rawOutputDigest: sha256("")
    }
  };
  await writeJson(join(consumerRoot, qualification.evidencePath), {
    ...evidenceWithoutDigest,
    evidenceDigest: sha256(
      qualificationModel.canonicalBufQualificationEvidence(evidenceWithoutDigest)
    )
  });
  await writeJson(
    join(consumerRoot, "architecture", "foundation", "protobuf-evolution.yaml"),
    {
      schemaVersion: 1,
      releasedBaselinePath: "architecture/contracts/protobuf/pack-consumer.control.json",
      approvedBreakingChanges: [],
      qualification,
      current
    }
  );
}
