import type { QualifiedDocsCohortBindingV2 } from "../../packages/docs-protocol-agent-teams/dist/qualification/index.js";
import type {
  CanaryAuthorityFetcher,
  CanaryAuthorityProjector,
  CanaryRepository,
  ProjectedCohortAuthority,
} from "../../scripts/public-managed-registry-canary-policy.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseCanaryInputs } from "../../scripts/public-managed-registry-canary-policy.mjs";

const commit = "a".repeat(40);
const authorityRevision = "b".repeat(40);
const sha256 = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const digest = (value: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const integrity = (byte: number): `sha512-${string}` =>
  `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
const descriptors = [
  ["repositoryMutation", "@agent-teams/repository-mutation", false],
  ["documentAuthoring", "@agent-teams/document-authoring", false],
  ["docsProtocol", "@agent-teams/docs-protocol", true],
  ["docsProtocolAgentTeams", "@agent-teams/docs-protocol-agent-teams", true],
  ["engineeringFoundation", "@agent-teams/engineering-foundation", true],
] as const;
const cohortV2DependencyEdges = [
  ["@agent-teams/document-authoring", "@agent-teams/repository-mutation"],
  ["@agent-teams/docs-protocol", "@agent-teams/document-authoring"],
  ["@agent-teams/docs-protocol", "@agent-teams/repository-mutation"],
  ["@agent-teams/docs-protocol-agent-teams", "@agent-teams/docs-protocol"],
  ["@agent-teams/docs-protocol-agent-teams", "@agent-teams/repository-mutation"],
  ["@agent-teams/engineering-foundation", "@agent-teams/document-authoring"],
  ["@agent-teams/engineering-foundation", "@agent-teams/repository-mutation"],
];
const cohortV2Schemas = {
  consumer_integration: 3,
  managed_state: 2,
  docs_protocol: 1,
  qualification_receipt: 3,
  foundation_plan: 1,
  foundation_journal: 1,
  foundation_receipt: 1,
  foundation_envelope: 5,
};
const fixturePackages = Object.fromEntries(
  descriptors.map(([key], index) => [
    key,
    {
      version: `1.0.${index}`,
      integrity: integrity(index + 1),
    },
  ]),
);
function fixturePackage(key: (typeof descriptors)[number][0]) {
  const coordinate = fixturePackages[key];
  assert.ok(coordinate);
  return coordinate;
}
const cohort: QualifiedDocsCohortBindingV2 = {
  schemaVersion: 2,
  cohortId: "docs-v2-canary",
  channel: "stable",
  recordDigest: sha256("1"),
  qualificationEventDigest: sha256("2"),
  eligibleAfter: "2026-09-04T12:00:00Z",
  upgradeFrom: ["docs-v1"],
  rollbackTo: ["docs-v1"],
  packages: {
    repositoryMutation: fixturePackage("repositoryMutation"),
    documentAuthoring: fixturePackage("documentAuthoring"),
    docsProtocol: fixturePackage("docsProtocol"),
    docsProtocolAgentTeams: fixturePackage("docsProtocolAgentTeams"),
    engineeringFoundation: fixturePackage("engineeringFoundation"),
  },
  workflow: {
    repository: "agent-teams-ai/.github",
    path: ".github/workflows/docs-protocol-check.yml",
    revision: "3".repeat(40),
    blobSha: "4".repeat(40),
  },
  assets: {
    skillDigest: sha256("5"),
    callerWorkflowDigest: sha256("6"),
    assetCatalogDigest: sha256("7"),
    transitionCatalogDigest: sha256("8"),
  },
  schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
  runtime: { node: ">=24.18.0 <25", pnpm: ">=11.17.0 <12", runtimeClosureDigest: sha256("9") },
};
const inputs = parseCanaryInputs({
  authorityRevision,
  cohortId: cohort.cohortId,
  expectedCommit: commit,
});
const projected = {
  repository: "agent-teams-ai/.github",
  path: "governance/docs-qualified-cohorts.json",
  revision: authorityRevision,
  cohort,
} satisfies ProjectedCohortAuthority;
const repository: CanaryRepository = {
  provider: "github",
  id: "1316243988",
  nameWithOwner: "agent-teams-ai/engineering-foundation",
};

function currentPackageAuthority([key, name, direct]: (typeof descriptors)[number], index: number) {
  const coordinate = cohort.packages[key];
  assert.ok(coordinate);
  const version = coordinate.version;
  const workflowRunId = 123;
  return {
    name,
    role: direct ? "direct" : "transitive",
    ...cohort.packages[key],
    registry: "https://registry.npmjs.org/",
    published_at: "2026-09-03T00:00:00Z",
    provenance: {
      source_repository: "agent-teams-ai/engineering-foundation",
      source_repository_id: 1316243988,
      source_workflow: ".github/workflows/release.yml",
      source_commit: `${index + 1}`.repeat(40),
      workflow_run_id: workflowRunId,
      workflow_run_attempt: 1,
      registry_attestation_url: `https://registry.npmjs.org/-/npm/v1/attestations/${name.replaceAll(
        "/",
        "%2f",
      )}@${version}`,
      workflow_run_url: `https://github.com/agent-teams-ai/engineering-foundation/actions/runs/${workflowRunId}`,
      signature_verified: true,
    },
  };
}

function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function registryFixture(
  records: readonly { cohort_id: string; cohort_generation: number }[] = [
    { cohort_id: cohort.cohortId, cohort_generation: 2 },
  ],
) {
  return {
    schema_version: 1,
    cohorts: records,
    events: [
      {
        sequence: 1,
        cohort_id: cohort.cohortId,
        state: "QUALIFIED",
        event_digest: cohort.qualificationEventDigest,
      },
    ],
  };
}

type FixtureRegistry = {
  readonly cohorts: readonly { readonly cohort_id: string; readonly cohort_generation: number }[];
  readonly events: readonly { readonly cohort_id: string; readonly state: string }[];
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertFixtureRegistry(
  value: Record<string, unknown>,
): asserts value is Record<string, unknown> & FixtureRegistry {
  assert.ok(Array.isArray(value.cohorts));
  for (const record of value.cohorts) {
    const entry: unknown = record;
    assert.ok(isRecord(entry));
    assert.equal(typeof entry.cohort_id, "string");
    assert.equal(typeof entry.cohort_generation, "number");
  }
  assert.ok(Array.isArray(value.events));
  for (const event of value.events) {
    const entry: unknown = event;
    assert.ok(isRecord(entry));
    assert.equal(typeof entry.cohort_id, "string");
    assert.equal(typeof entry.state, "string");
  }
}
function strictFixtureProjector(
  input: Parameters<CanaryAuthorityProjector>[0],
): ProjectedCohortAuthority {
  assertFixtureRegistry(input.registry);
  const matches = input.registry.cohorts.filter(({ cohort_id: id }) => id === input.cohortId);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error("Cohort must occur exactly once");
  }
  if (matches[0].cohort_generation !== 2) {
    throw new Error("wrong Cohort generation");
  }
  const events = input.registry.events.filter(({ cohort_id: id }) => id === input.cohortId);
  const qualified = events.filter(({ state }) => state === "QUALIFIED");
  const latest = events.at(-1)?.state;
  if (qualified.length !== 1 || latest === undefined || !["QUALIFIED", "CANARY"].includes(latest)) {
    throw new Error("Cohort is not eligible for canary");
  }
  assert.deepEqual(input.repository, repository);
  return projected;
}

function centralFetcher({
  branchProtected = true,
  branchSha = authorityRevision,
  registry = registryFixture(),
}: {
  branchProtected?: boolean;
  branchSha?: string;
  registry?: unknown;
} = {}): CanaryAuthorityFetcher {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["schema_version", "cohorts", "events"],
    properties: {
      schema_version: { const: 1 },
      cohorts: { type: "array" },
      events: { type: "array" },
    },
  };
  return async (url: Parameters<typeof fetch>[0]): Promise<Response> => {
    const value = String(url).endsWith("/branches/main")
      ? { protected: branchProtected, commit: { sha: branchSha } }
      : String(url).endsWith(".schema.json")
        ? schema
        : registry;
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

export {
  commit,
  authorityRevision,
  sha256,
  digest,
  integrity,
  descriptors,
  cohortV2DependencyEdges,
  cohortV2Schemas,
  cohort,
  inputs,
  projected,
  repository,
  currentPackageAuthority,
  canonicalJson,
  registryFixture,
  strictFixtureProjector,
  centralFetcher,
};
