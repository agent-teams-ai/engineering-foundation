import assert from "node:assert/strict";
import { createHash } from "node:crypto";

interface ProbeAttestationInput {
  readonly scenario: string;
  readonly sourceCommit: string;
  readonly versions: ReadonlyMap<string, string>;
  readonly archiveByName: ReadonlyMap<string, { readonly bytes: Uint8Array }>;
  readonly firstPackageName: string;
  readonly events: readonly { readonly operation: string }[];
}

function statement(name: string, input: ProbeAttestationInput) {
  const archive = input.archiveByName.get(name);
  assert.ok(archive);
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${input.versions.get(name)}`,
        digest: { sha512: createHash("sha512").update(archive.bytes).digest("hex") },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: "refs/heads/main",
            repository: "https://github.com/fixture/release-probe",
            path: ".github/workflows/release.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/fixture/release-probe@refs/heads/main",
            digest: { gitCommit: input.sourceCommit },
          },
        ],
      },
    },
  };
}

export function createProbeAttestations(input: ProbeAttestationInput) {
  const { scenario, firstPackageName, events, versions } = input;
  const bundle = (name: string) => ({
    predicateType: "https://slsa.dev/provenance/v1",
    bundle: {
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(statement(name, input))).toString("base64"),
      },
    },
  });
  const auditResult = (installed: string | undefined) => {
    assert.ok(installed !== undefined && installed.length > 0);
    const provenanceBundle = bundle(installed);
    const entry = {
      name: installed,
      version: versions.get(installed),
      attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
      attestationBundles: [
        provenanceBundle,
        { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1" },
      ],
    };
    const evidence = { invalid: [], missing: [], verified: [entry] };
    if (installed === firstPackageName) {
      if (
        scenario === "attestation-empty-persistent" ||
        (scenario === "attestation-empty-then-valid" &&
          events.filter((event) => event.operation === "signature").length === 1)
      ) {
        evidence.verified = [];
      }
      if (scenario === "attestation-malformed-json") {
        return { status: 0, stdout: "credential-secret", stderr: "" };
      }
      // These deliberate malformed wire values cross the real JSON decoder.
      if (scenario === "attestation-malformed-evidence") {
        Reflect.set(evidence, "verified", {});
      }
      if (scenario === "attestation-malformed-bundles") {
        Reflect.set(entry, "attestationBundles", {});
      }
      if (scenario === "attestation-invalid") {
        Reflect.set(evidence, "invalid", [{ message: "credential-secret" }]);
      }
      if (scenario === "attestation-missing-signature") {
        Reflect.set(evidence, "missing", [{ message: "credential-secret" }]);
      }
      if (scenario === "attestation-ambiguous-target") {
        evidence.verified.push(entry);
      }
      if (scenario === "attestation-ambiguous-bundles") {
        entry.attestationBundles.push(provenanceBundle);
      }
      if (scenario === "attestation-partial") {
        entry.attestationBundles.pop();
      }
      if (["attestation-wrong-source", "attestation-wrong-sri"].includes(scenario)) {
        const payload = statement(installed, input);
        if (scenario === "attestation-wrong-source") {
          payload.predicate.buildDefinition.externalParameters.workflow.repository =
            "https://github.com/other/repository";
        } else {
          const subject = payload.subject.at(0);
          assert.ok(subject !== undefined);
          subject.digest.sha512 = "0".repeat(128);
        }
        provenanceBundle.bundle.dsseEnvelope.payload = Buffer.from(
          JSON.stringify(payload),
        ).toString("base64");
      }
    }
    return { status: 0, stdout: JSON.stringify(evidence), stderr: "" };
  };
  return { bundle, auditResult };
}
