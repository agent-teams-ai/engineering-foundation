import type { ChangeFingerprint } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/ports/change-fingerprint.js";
import { growthObservationReference } from "../../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js";
import type { DraftPacked } from "./growth-authority-test-ports.ts";
const d = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
export function promotionCandidateMutations(): [
  string,
  (candidate: DraftPacked) => void,
  RegExp,
][] {
  return [
    [
      "repository",
      (candidate) => {
        candidate.observation.repository = "github:999";
      },
      /growth-authority-packed-repository-mismatch/u,
    ],
    [
      "source commit",
      (candidate) => {
        candidate.observation.sourceCommit = "9".repeat(40);
      },
      /growth-authority-candidate-invocation-mismatch/u,
    ],
    [
      "source tree",
      (candidate) => {
        candidate.observation.sourceTree = "9".repeat(40);
      },
      /growth-authority-candidate-invocation-mismatch/u,
    ],
    [
      "topology digest",
      (candidate) => {
        candidate.observation.topologyDigest = d("f");
      },
      /growth-authority-candidate-invocation-mismatch/u,
    ],
    [
      "lock digest",
      (candidate) => {
        candidate.observation.lockDigest = d("f");
      },
      /growth-authority-candidate-invocation-mismatch/u,
    ],
    [
      "toolchain digest",
      (candidate) => {
        candidate.observation.toolchainDigest = d("f");
      },
      /growth-authority-candidate-invocation-mismatch/u,
    ],
    [
      "artifact digests",
      (candidate) => {
        candidate.observation.artifactDigests = [d("f")];
      },
      /growth-authority-candidate-invocation-mismatch/u,
    ],
    [
      "tool version",
      (candidate) => {
        candidate.observation.tool.version = "1.3.4";
      },
      /growth-authority-candidate-invocation-mismatch/u,
    ],
    [
      "tool distribution artifact",
      (candidate) => {
        candidate.observation.tool.artifactDigest = d("f");
      },
      /growth-authority-candidate-invocation-mismatch/u,
    ],
    [
      "tool extractor",
      (candidate) => {
        candidate.observation.tool.extractorVersion = "7.58.13";
      },
      /growth-authority-candidate-invocation-mismatch/u,
    ],
  ];
}
export function synchronizePackedObservation(
  candidate: DraftPacked,
  fingerprint: ChangeFingerprint,
) {
  candidate.source = {
    commit: candidate.observation.sourceCommit,
    tree: candidate.observation.sourceTree,
  };
  candidate.installedDistribution.source = structuredClone(candidate.source);
  candidate.observationDigest = growthObservationReference(
    candidate.observation,
    fingerprint,
  ).surfaceDigest;
  candidate.installedDistribution.observationDigest = candidate.observationDigest;
}
