import {
  DOCUMENT_AUTHORING_PACKAGE, DOCS_PACKAGE, DOCS_MCP_PACKAGE, FOUNDATION_PACKAGE,
  npmPurlName, orderedRelease, tarballIntegrity,
} from "../../scripts/release-publish-ordered.mjs";

const source = {
  commit: "a".repeat(40),
  ref: "refs/heads/main",
  repository: "https://github.com/agent-teams-ai/engineering-foundation",
  workflow: ".github/workflows/release.yml",
  isTrustedCommit: async (commit) => commit === "a".repeat(40),
};
const MUTATION_PACKAGE = "@agent-teams/repository-mutation";
const DOCS_ADAPTER_PACKAGE = "@agent-teams/docs-protocol-agent-teams";
const mutation = artifact(MUTATION_PACKAGE, "0.1.0", {});
const authoring = artifact(DOCUMENT_AUTHORING_PACKAGE, "0.1.0", {
  [MUTATION_PACKAGE]: mutation.version,
});
const foundation = artifact(FOUNDATION_PACKAGE, "1.2.3", {
  [DOCUMENT_AUTHORING_PACKAGE]: authoring.version,
  [MUTATION_PACKAGE]: mutation.version,
});
const docs = artifact(DOCS_PACKAGE, "2.0.0", {
  [DOCUMENT_AUTHORING_PACKAGE]: authoring.version,
  [MUTATION_PACKAGE]: mutation.version,
});
const docsAdapter = artifact(DOCS_ADAPTER_PACKAGE, "0.1.0", {
  [DOCS_PACKAGE]: docs.version,
  [MUTATION_PACKAGE]: mutation.version,
});
const docsMcp = artifact(DOCS_MCP_PACKAGE, "0.1.0", { [DOCS_PACKAGE]: docs.version });
const RELEASE_TIMESTAMPS = new Map([
  [MUTATION_PACKAGE, "2026-01-01T00:00:00.000Z"],
  [DOCUMENT_AUTHORING_PACKAGE, "2026-01-01T00:00:01.000Z"],
  [FOUNDATION_PACKAGE, "2026-01-01T00:00:02.000Z"],
  [DOCS_PACKAGE, "2026-01-01T00:00:03.000Z"],
  [DOCS_ADAPTER_PACKAGE, "2026-01-01T00:00:04.000Z"],
  [DOCS_MCP_PACKAGE, "2026-01-01T00:00:05.000Z"],
]);

function artifact(name, version, dependencies) {
  const manifest = { dependencies, name, version };
  return { integrity: tarballIntegrity(Buffer.from(JSON.stringify(manifest))), manifest, name, version };
}

function argumentField(args, prefix) {
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function artifactProvenance(value, commit = source.commit) {
  return {
    commit,
    dependencyUri: `git+${source.repository}@${source.ref}`,
    ref: source.ref,
    repository: source.repository,
    sha512: Buffer.from(value.integrity.slice("sha512-".length), "base64").toString("hex"),
    subjectName: `pkg:npm/${npmPurlName(value.name)}@${value.version}`,
    workflow: source.workflow,
  };
}

function provenanceStatement(value, provenance = artifactProvenance(value)) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicate: { buildDefinition: {
      externalParameters: { workflow: {
        path: provenance.workflow, ref: provenance.ref, repository: provenance.repository,
      } },
      resolvedDependencies: [{
        digest: { gitCommit: provenance.commit }, uri: provenance.dependencyUri,
      }],
    } },
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{
      digest: { sha512: provenance.sha512 }, name: provenance.subjectName,
    }],
  };
}

function auditEvidence(value, provenance = artifactProvenance(value)) {
  const payload = Buffer.from(JSON.stringify(provenanceStatement(value, provenance))).toString("base64");
  return {
    invalid: [],
    missing: [],
    verified: [{
      attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
      attestationBundles: [
        { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1" },
        { bundle: { dsseEnvelope: {
          payload, payloadType: "application/vnd.in-toto+json",
        } }, predicateType: "https://slsa.dev/provenance/v1" },
      ],
      name: value.name,
      version: value.version,
    }],
  };
}

function present(value, publishedAt, tag = "latest") {
  return {
    integrity: value.integrity,
    distTags: { [tag]: value.version },
    manifest: structuredClone(value.manifest),
    provenance: artifactProvenance(value),
    publishedAt,
    status: "present",
  };
}

function publishedState(...values) {
  return Object.fromEntries(values.map((value) => [
    value.name,
    present(value, RELEASE_TIMESTAMPS.get(value.name)),
  ]));
}

function harness(initial = {}) {
  const calls = [];
  const states = new Map(Object.entries(initial));
  const resolveState = async (value) => {
    const state = states.get(value.name);
    return typeof state === "function" ? await state(value) : (state ?? { status: "absent" });
  };
  return {
    authorizePublish: (value) => {
      calls.push(`authorize:${value.name}`);
    },
    calls,
    states,
    inspect: async (value) => {
      calls.push(`inspect:${value.name}`);
      return await resolveState(value);
    },
    publish: async (value, tag) => {
      calls.push(`publish:${value.name}:${tag}`);
      const timestamp = RELEASE_TIMESTAMPS.get(value.name);
      const published = present(value, timestamp, tag);
      states.set(value.name, published);
    },
    reconcileRelease: async (value) => calls.push(`release:${value.name}`),
    verifySignature: async (value) => {
      calls.push(`signature:${value.name}`);
      const state = await resolveState(value);
      if (state?.status !== "present") {
        throw new Error(`Signature verification requires a present snapshot for ${value.name}.`);
      }
      return structuredClone(state.provenance);
    },
  };
}

async function run(runtime, overrides = {}) {
  return await orderedRelease({
    artifacts: [docsMcp, docsAdapter, docs, foundation, authoring, mutation],
    attempts: 2,
    finalTag: "latest",
    retryDelayMilliseconds: 0,
    source,
    ...runtime,
    ...overrides,
  });
}

export { source, MUTATION_PACKAGE, DOCS_ADAPTER_PACKAGE, mutation, authoring, foundation, docs, docsAdapter, docsMcp, RELEASE_TIMESTAMPS, artifact, argumentField, artifactProvenance, auditEvidence, present, publishedState, harness, run };
