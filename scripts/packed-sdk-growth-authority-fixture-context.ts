import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  archiveIdentity,
  canonicalCustody,
  canonicalJson,
  compareCanonical,
  digest,
  installedInventoryReader,
} from "./packed-sdk-growth-authority-fixture-values.ts";
import type { FixtureInput } from "./packed-sdk-growth-authority-fixture-values.ts";
import {
  metadataRootEvidence,
  qualifyMetadataCoverage,
  selectFixtureObservation,
  packedEvidence,
  expectedReportCoverage,
} from "./packed-sdk-growth-authority-fixture-evidence.ts";
import type {
  GrowthAuthorityBinding,
  GrowthDigest,
  GrowthInvocation,
  GrowthObservationReference,
} from "../packages/engineering-foundation/dist/sdk-growth-authority.js";

type MutableBinding = {
  -readonly [Key in keyof GrowthAuthorityBinding]: GrowthAuthorityBinding[Key];
};
async function createFixtureBinding(
  input: FixtureInput,
  baseReference: GrowthObservationReference,
  invocation: GrowthInvocation,
): Promise<MutableBinding> {
  const foundationArchive = archiveIdentity(await readFile(input.foundationArchivePath));
  const binding: MutableBinding = {
    invocation,
    target: {
      repository: {
        provider: "github",
        repositoryId: "123",
        owner: "agent-teams-ai",
        name: "packed-sdk-fixture",
      },
      pullRequestNumber: 317,
      head: { commit: invocation.sourceCommit, tree: invocation.sourceTree },
      base: { commit: baseReference.sourceCommit, tree: baseReference.sourceTree },
      mergeBase: { commit: baseReference.sourceCommit, tree: baseReference.sourceTree },
      evaluation: { commit: invocation.sourceCommit, tree: invocation.sourceTree },
      evaluationKind: "head",
    },
    verifier: {
      identity: "packed/reviewrouter",
      immutableRevision: "7".repeat(40),
      artifactDigest: digest("packed-verifier"),
    },
    tool: {
      packageName: "@agent-teams/engineering-foundation",
      version: invocation.tool.version,
      ...foundationArchive,
      distributionDigest: invocation.tool.artifactDigest,
      extractorVersion: invocation.tool.extractorVersion,
    },
    policy: {
      contractRevision: "foundation:sdk-growth:c0:5",
      policyVersion: "foundation:sdk-growth:policy:1",
      enrollmentRevision: "8".repeat(40),
      configurationDigest: `sha256:${createHash("sha256")
        .update(await readFile(join(input.repositoryRoot, "policy.yaml")))
        .digest("hex")}`,
      scopeDigest: digest({
        domain: "reviewrouter:sdk-growth-authority:scope:1",
        packages: input.config.packages,
      }),
      commandDigest: digest({
        domain: "reviewrouter:sdk-growth-authority:command:1",
        entrypoint: "@agent-teams/engineering-foundation/sdk-growth-authority",
        operations: ["check", "promote-release"],
      }),
    },
    historyDigest: digest("packed-history"),
    evidenceManifestDigest: digest("packed-evidence-manifest"),
  };
  return binding;
}

export async function prepareFixtureContext(input: FixtureInput) {
  const candidate = input.matchedReport.candidate.value;
  const rootEvidence = await metadataRootEvidence(input);
  const trustedBase = {
    ...qualifyMetadataCoverage(
      await selectFixtureObservation(input, input.trustedBase, input.releasedArchivePath),
      rootEvidence,
    ),
    repository: "github:123",
  };
  const baseReference = {
    ...input.baseReference,
    surfaceDigest: digest({ domain: "foundation:sdk-growth:observation:1", payload: trustedBase }),
  };
  const invocation = {
    repository: "github:123",
    sourceCommit: candidate.sourceCommit,
    sourceTree: candidate.sourceTree,
    topologyDigest: candidate.topologyDigest,
    lockDigest: candidate.lockDigest,
    toolchainDigest: candidate.toolchainDigest,
    artifactDigests: candidate.artifactDigests,
    tool: input.matchedReport.tool,
  };
  const binding = await createFixtureBinding(input, baseReference, invocation);
  const normalizedDecision = {
    ...input.decision,
    transitions: [...input.decision.transitions].toSorted(),
    coordinates: [...input.decision.coordinates].toSorted(compareCanonical),
    consumerEvidenceRefs: [...input.decision.consumerEvidenceRefs].toSorted(compareCanonical),
  };
  const decisionDigest = digest({
    domain: "foundation:sdk-growth:decision:1",
    payload: normalizedDecision,
  });
  const installations = new Map<GrowthDigest, string>();
  const installedInventory = installedInventoryReader(installations);
  const archive = await packedEvidence(
    input.releasedArchivePath,
    trustedBase,
    input.packageName,
    installations,
  );
  const candidateObservation = {
    ...qualifyMetadataCoverage(
      await selectFixtureObservation(input, input.candidateObservation, input.candidateArchivePath),
      rootEvidence,
    ),
    repository: invocation.repository,
  };
  const candidateArchive = await packedEvidence(
    input.candidateArchivePath,
    candidateObservation,
    input.packageName,
    installations,
  );
  const expectedCoverage = expectedReportCoverage(
    trustedBase,
    candidateObservation,
    input.positivePromotion === true,
  );
  const historicalCustody = canonicalCustody([
    {
      path: "trusted-base.json",
      contentHex: Buffer.from(canonicalJson(trustedBase)).toString("hex"),
    },
  ]);
  binding.evidenceManifestDigest = digest({
    domain: "foundation:sdk-growth:evidence-manifest:2",
    payload: {
      archives: [
        { packageName: input.packageName, custodyEvidenceDigest: archive.custodyEvidenceDigest },
      ],
      candidates: [
        {
          packageName: input.packageName,
          custodyEvidenceDigest: candidateArchive.custodyEvidenceDigest,
        },
      ],
      metadataRoots: [
        {
          packageName: rootEvidence.evidence.packageName,
          evidenceDigest: rootEvidence.evidenceDigest,
        },
      ],
      retainedHistory: digest({
        domain: "foundation:sdk-growth:custody:1",
        payload: historicalCustody,
      }),
    },
  });
  return {
    binding,
    trustedBase,
    baseReference,
    rootEvidence,
    archive,
    candidateArchive,
    expectedCoverage,
    historicalCustody,
    decisionDigest,
    installedInventory,
  };
}
export type FixtureContext = Awaited<ReturnType<typeof prepareFixtureContext>>;
