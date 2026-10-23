import assert from "node:assert/strict";
import { canonicalDigest } from "./pack-test-support.mjs";
export function fixtureDecision(
  transitions: readonly { fingerprint: string; coordinate: unknown }[],
  report: {
    repository: string;
    candidate: {
      value: { sourceTree: string; topologyDigest: string; artifactDigests: readonly string[] };
    };
  },
) {
  const fingerprints = transitions.map((row) => row.fingerprint).toSorted();
  return {
    contractRevision: "foundation:sdk-growth:c0:5",
    decisionId: "SDK-PACKED-1",
    ownerRef: "fixture/sdk-owner",
    stability: "development",
    transitions: fingerprints,
    coordinates: transitions.map((row) => row.coordinate),
    changeFingerprint: canonicalDigest({
      domain: "foundation:sdk-growth:group:1",
      policyVersion: "foundation:sdk-growth:policy:1",
      transitions: fingerprints,
    }),
    consumerEvidenceRefs: [
      {
        useCase: "Packed condition-order qualification",
        repository: report.repository,
        source: {
          tree: report.candidate.value.sourceTree,
          contentDigest: report.candidate.value.topologyDigest,
          commit: null,
        },
        artifactDigest: report.candidate.value.artifactDigests[0],
      },
    ],
    exposureRationale: "Observe ordered package resolution",
    compatibilityRationale: "Preserve original typed contract",
    lifecycle: { kind: "ordinary" },
  };
}

export function missingSdkDecision(missing: {
  aggregate: { capabilities: readonly [{ diagnostics: readonly { ruleId: string }[] }] };
  report: Parameters<typeof fixtureDecision>[1] & {
    trustedBaseComparison: { findings: Parameters<typeof fixtureDecision>[0] };
  };
}) {
  assert.ok(
    missing.aggregate.capabilities[0].diagnostics.some((row) =>
      row.ruleId.endsWith("growth-transition-unadmitted"),
    ),
  );
  const transitions = missing.report.trustedBaseComparison.findings;
  assert.ok(transitions.length > 0, "Condition order must retain a concrete transition");
  return fixtureDecision(transitions, missing.report);
}
