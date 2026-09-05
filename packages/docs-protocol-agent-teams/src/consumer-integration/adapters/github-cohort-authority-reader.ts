import type {
  ConsumerUpgradeAuthorityReader
} from "../application/ports/consumer-upgrade.js";
import type {
  ConsumerIntegrationDesiredState,
  ConsumerIntegrationDesiredStateV1,
  ConsumerUpgradeAuthorityV1,
  ConsumerUpgradeAuthorityV2,
  QualifiedDocsCohortBindingV1,
  QualifiedDocsCohortBindingV2
} from "../domain/model.js";
import {
  assertQualifiedDocsCohortBindingV1,
  assertQualifiedDocsCohortBindingV2
} from "../application/policies/consumer-integration-desired-state.js";
import {
  QUALIFIED_DOCS_COHORT_V2_PACKAGES
} from "../application/policies/qualified-docs-cohort-v2.js";
import {
  assertCohortAuthorityV2,
  assertCohortEventChainV2
} from "./cohort-v2-authority-validator.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { parseJsonRecord } from "./strict-json-record.js";

const AUTHORITY_REPOSITORY = "agent-teams-ai/.github";
const AUTHORITY_PATH = "governance/docs-qualified-cohorts.json";
const AUTHORITY_API = `https://api.github.com/repos/${AUTHORITY_REPOSITORY}`;
const AUTHORITY_RAW = `https://raw.githubusercontent.com/${AUTHORITY_REPOSITORY}`;
const GIT_SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
const MAXIMUM_AUTHORITY_BYTES = 8 * 1024 * 1024;
const V1_MANAGED_PACKAGES = [
  "@agent-teams/docs-protocol",
  "@agent-teams/engineering-foundation"
] as const;

type AuthorityFetch = (
  input: string | URL | globalThis.Request,
  init?: RequestInit
) => Promise<Response>;

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} must be one plain object.`
    );
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 4096) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} must be one bounded array.`
    );
  }
  return value;
}

function string(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 ||
    value.includes("\u0000")) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} must be one bounded string.`
    );
  }
  return value;
}

async function responseBytes(response: Response, subject: string): Promise<Uint8Array> {
  if (!response.ok) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_UNAVAILABLE",
      `${subject} returned HTTP ${response.status}.`
    );
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAXIMUM_AUTHORITY_BYTES) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} exceeds the authority size limit.`
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_AUTHORITY_BYTES) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${subject} has invalid or overlong bytes.`
    );
  }
  return bytes;
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(20_000);
}

async function resolveAuthorityRevision(fetcher: AuthorityFetch): Promise<string> {
  const bytes = await responseBytes(await fetcher(`${AUTHORITY_API}/commits/main`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-teams-docs" },
    redirect: "error",
    signal: timeoutSignal()
  }), "Central authority revision");
  const response = parseJsonRecord(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const revision = response["sha"];
  if (typeof revision !== "string" || !GIT_SHA.test(revision)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Central authority did not resolve one exact Git revision."
    );
  }
  return revision;
}

async function readAuthorityRegistry(
  fetcher: AuthorityFetch,
  revision: string
): Promise<Record<string, unknown>> {
  const bytes = await responseBytes(await fetcher(
    `${AUTHORITY_RAW}/${revision}/${AUTHORITY_PATH}`,
    {
      headers: { Accept: "application/json", "User-Agent": "agent-teams-docs" },
      redirect: "error",
      signal: timeoutSignal()
    }
  ), "Central Cohort registry");
  try {
    return parseJsonRecord(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Central Cohort registry is not strict duplicate-free UTF-8 JSON.",
      { cause: error }
    );
  }
}

function selectedLifecycleState(
  events: readonly unknown[],
  cohortId: string
): { readonly qualificationEventDigest: string; readonly state: string; readonly supportUntil: unknown } {
  const selected = events.map((value) => record(value, "Cohort lifecycle event"))
    .filter((event) => event["cohort_id"] === cohortId)
    .map((event) => {
      const sequence = event["sequence"];
      if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_AUTHORITY_INVALID",
          `${cohortId} has an invalid lifecycle sequence.`
        );
      }
      return { event, sequence: Number(sequence) };
    })
    .toSorted((left, right) => left.sequence - right.sequence);
  if (new Set(selected.map(({ sequence }) => sequence)).size !== selected.length) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${cohortId} has duplicate lifecycle sequences.`
    );
  }
  const qualification = selected.filter(({ event }) => event["state"] === "QUALIFIED");
  const last = selected.at(-1);
  if (qualification.length !== 1 || last === undefined) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      `${cohortId} does not have one immutable QUALIFIED lifecycle event.`
    );
  }
  return {
    qualificationEventDigest: string(
      qualification[0]!.event["event_digest"],
      "QUALIFIED event digest"
    ),
    state: string(last.event["state"], "Current Cohort lifecycle state"),
    supportUntil: last.event["support_until"]
  };
}

function assertSelectable(
  source: Record<string, unknown>,
  state: string,
  repository: ConsumerIntegrationDesiredStateV1["repository"]
): void {
  if (state === "RECOMMENDED") {return;}
  const canaries = array(source["canary_repositories"], "Cohort canary repositories")
    .map((entry) => record(entry, "Cohort canary repository"));
  if (["QUALIFIED", "CANARY"].includes(state) && canaries.some((entry) =>
    String(entry["repository_id"]) === repository.id
  )) {return;}
  throw new ConsumerIntegrationNodeError(
    "DOCS_CONSUMER_COHORT_NOT_SELECTABLE",
    `${String(source["cohort_id"])} is ${state} and is not selectable for repository ${repository.id}.`
  );
}

function packageRecords(source: Record<string, unknown>): Map<unknown, Record<string, unknown>> {
  const entries = array(source["packages"], "Cohort packages")
    .map((value) => record(value, "Cohort package"));
  const packageByName = new Map(entries.map((entry) => [entry["name"], entry]));
  if (packageByName.size !== entries.length) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Qualified Cohort package identities must be unique."
    );
  }
  return packageByName;
}

function packageProjectionV1(source: Record<string, unknown>) {
  const packageByName = packageRecords(source);
  if (packageByName.size !== V1_MANAGED_PACKAGES.length ||
    V1_MANAGED_PACKAGES.some((name) => !packageByName.has(name))) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Qualified Cohort v1 must select exactly its two canonical packages."
    );
  }
  const docs = packageByName.get(V1_MANAGED_PACKAGES[0])!;
  const foundation = packageByName.get(V1_MANAGED_PACKAGES[1])!;
  return {
    docsProtocol: {
      version: string(docs["version"], "Docs Protocol version"),
      integrity: string(docs["integrity"], "Docs Protocol integrity")
    },
    engineeringFoundation: {
      version: string(foundation["version"], "Foundation version"),
      integrity: string(foundation["integrity"], "Foundation integrity")
    }
  };
}

function packageProjectionV2(source: Record<string, unknown>) {
  const packageByName = packageRecords(source);
  if (packageByName.size !== QUALIFIED_DOCS_COHORT_V2_PACKAGES.length ||
    QUALIFIED_DOCS_COHORT_V2_PACKAGES.some(({ name }) => !packageByName.has(name))) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Qualified Cohort v2 must select exactly its five canonical packages."
    );
  }
  return Object.fromEntries(QUALIFIED_DOCS_COHORT_V2_PACKAGES.map(({ key, name }) => {
    const coordinate = packageByName.get(name)!;
    return [key, {
      version: string(coordinate["version"], `${name} version`),
      integrity: string(coordinate["integrity"], `${name} integrity`)
    }];
  })) as QualifiedDocsCohortBindingV2["packages"];
}

type AuthorityProjection = ConsumerUpgradeAuthorityV1 | ConsumerUpgradeAuthorityV2;
type CohortProjection = QualifiedDocsCohortBindingV1 | QualifiedDocsCohortBindingV2;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\u0000") === [...keys].toSorted().join("\u0000");
}

const LEGACY_V1_RECORD_KEYS = [
  "assets", "canary_repositories", "channel", "cohort_id", "eligible_after",
  "evidence_references", "packages", "record_digest", "reusable_workflow", "rollback_to",
  "runtime", "runtime_closure", "schemas", "upgrade_from"
] as const;

const LEGACY_V1_SCHEMA = Object.freeze({
  consumer_integration: 1,
  consumer_plan: 1,
  managed_state: 1,
  foundation_plan: 1,
  foundation_journal: 1,
  foundation_receipt: 1,
  foundation_envelope: 5,
  docs_protocol: 1
});
function assertLegacySchema(schemas: Record<string, unknown>): void {
  if (!hasExactKeys(schemas, Object.keys(LEGACY_V1_SCHEMA)) ||
    Object.entries(LEGACY_V1_SCHEMA).some(([key, value]) => schemas[key] !== value)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Historical Cohort v1 schemas must match the immutable eight-coordinate legacy shape."
    );
  }
}

function recordGeneration(source: Record<string, unknown>, requested: unknown): 1 | 2 {
  const discriminator = source["cohort_generation"];
  if (requested === 1) {
    if (discriminator !== undefined || !hasExactKeys(source, LEGACY_V1_RECORD_KEYS)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_AUTHORITY_INVALID",
        "Requested Cohort v1 must have no discriminator and match the immutable legacy shape."
      );
    }
    return 1;
  }
  if (requested !== 2) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Requested Cohort generation is unknown or unsupported."
    );
  }
  if (discriminator !== 2) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Cohort generation discriminator is unknown or unsupported."
    );
  }
  if (!hasExactKeys(source, [
    ...LEGACY_V1_RECORD_KEYS, "cohort_generation", "dependency_edges"
  ])) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Qualified Cohort v2 must match its closed discriminator-bearing record shape."
    );
  }
  return 2;
}

function cohortProjection(
  source: Record<string, unknown>,
  qualificationEventDigest: string,
  requestedGeneration: 1 | 2
): CohortProjection {
  const workflow = record(source["reusable_workflow"], "Cohort reusable workflow");
  const assets = record(source["assets"], "Cohort assets");
  const skill = record(assets["skill"], "Cohort Skill asset");
  const caller = record(assets["caller_workflow"], "Cohort caller workflow asset");
  const assetCatalog = record(assets["asset_catalog"], "Cohort asset catalog");
  const transitionCatalog = record(assets["transition_catalog"], "Cohort transition catalog");
  const runtime = record(source["runtime"], "Cohort runtime");
  const runtimeClosure = record(source["runtime_closure"], "Cohort runtime closure");
  const schemas = record(source["schemas"], "Cohort schemas");
  const generation = recordGeneration(source, requestedGeneration);
  if (generation === 1) {
    assertLegacySchema(schemas);
  } else {
    assertCohortAuthorityV2(source);
  }
  const projection = {
    schemaVersion: generation,
    cohortId: string(source["cohort_id"], "Cohort ID"),
    channel: string(source["channel"], "Cohort channel"),
    recordDigest: string(source["record_digest"], "Cohort record digest"),
    qualificationEventDigest,
    eligibleAfter: string(source["eligible_after"], "Cohort eligibility timestamp"),
    upgradeFrom: array(source["upgrade_from"], "Cohort upgrade origins").map((entry) =>
      string(entry, "Cohort upgrade origin")
    ),
    rollbackTo: array(source["rollback_to"], "Cohort rollback targets").map((entry) =>
      string(entry, "Cohort rollback target")
    ),
    packages: generation === 1 ? packageProjectionV1(source) : packageProjectionV2(source),
    workflow: {
      repository: string(workflow["repository"], "Workflow repository"),
      path: string(workflow["path"], "Workflow path"),
      revision: string(workflow["revision"], "Workflow revision"),
      blobSha: string(workflow["blob_sha"], "Workflow blob SHA")
    },
    assets: {
      skillDigest: string(skill["digest"], "Skill digest"),
      callerWorkflowDigest: string(caller["rendered_digest"], "Caller workflow digest"),
      assetCatalogDigest: string(assetCatalog["digest"], "Asset catalog digest"),
      transitionCatalogDigest: string(transitionCatalog["digest"], "Transition catalog digest")
    },
    schemas: {
      consumerIntegration: schemas["consumer_integration"],
      managedState: schemas["managed_state"],
      docsProtocol: schemas["docs_protocol"]
    },
    runtime: {
      node: string(runtime["node"], "Node runtime"),
      pnpm: string(runtime["pnpm"], "pnpm runtime"),
      runtimeClosureDigest: string(runtimeClosure["digest"], "Runtime closure digest")
    }
  } as CohortProjection;
  if (projection.schemaVersion === 1) {
    assertQualifiedDocsCohortBindingV1(projection);
  } else {
    assertQualifiedDocsCohortBindingV2(projection);
  }
  return Object.freeze(projection);
}

export function projectQualifiedCohortAuthority(input: {
  readonly cohortId: string;
  readonly generation: 1 | 2;
  readonly registry: Record<string, unknown>;
  readonly repository: ConsumerIntegrationDesiredState["repository"];
  readonly revision: string;
  readonly restorationBinding?: "origin" | "source";
}): ConsumerUpgradeAuthorityV1 | ConsumerUpgradeAuthorityV2 {
  if (input.registry["schema_version"] !== 1) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Central Cohort registry must use contract schema_version 1."
    );
  }
  const matches = array(input.registry["cohorts"], "Qualified Cohorts")
    .map((value) => record(value, "Qualified Cohort"))
    .filter((cohort) => cohort["cohort_id"] === input.cohortId);
  if (matches.length !== 1) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_COHORT_UNKNOWN",
      `${input.cohortId} is not one exact central Cohort.`
    );
  }
  const source = matches[0]!;
  if (input.generation === 2) {
    assertCohortEventChainV2(array(input.registry["events"], "Cohort lifecycle events"), source);
  }
  const lifecycle = selectedLifecycleState(
    array(input.registry["events"], "Cohort lifecycle events"),
    input.cohortId
  );
  if (input.restorationBinding !== undefined && lifecycle.state === "SUPERSEDED") {
    const until = typeof lifecycle.supportUntil === "string" ? Date.parse(lifecycle.supportUntil) : NaN;
    if (!Number.isFinite(until) || Date.now() >= until) {
      throw new ConsumerIntegrationNodeError("DOCS_CONSUMER_COHORT_NOT_SELECTABLE", "Recorded binding support has expired.");
    }
  } else if (!(input.restorationBinding === "source" && lifecycle.state === "SUSPENDED")) {
    assertSelectable(source, lifecycle.state, input.repository);
  }
  const cohort = cohortProjection(source, lifecycle.qualificationEventDigest, input.generation);
  return Object.freeze({
    repository: AUTHORITY_REPOSITORY,
    path: AUTHORITY_PATH,
    revision: input.revision,
    cohort
  }) as AuthorityProjection;
}

export class GitHubCohortAuthorityReader implements ConsumerUpgradeAuthorityReader {
  readonly #fetcher: AuthorityFetch;

  public constructor(fetcher: AuthorityFetch = globalThis.fetch) {
    this.#fetcher = fetcher;
  }

  public async readRestoration(options: {
    readonly source: QualifiedDocsCohortBindingV2;
    readonly origin: QualifiedDocsCohortBindingV1;
    readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
  }): Promise<{ readonly source: AuthorityProjection; readonly target: AuthorityProjection }> {
    const revision = await resolveAuthorityRevision(this.#fetcher);
    const registry = await readAuthorityRegistry(this.#fetcher, revision);
    const common = { registry, revision, repository: options.repository };
    const source = projectQualifiedCohortAuthority({ ...common,
      cohortId: options.source.cohortId, generation: 2, restorationBinding: "source"
    });
    const target = projectQualifiedCohortAuthority({ ...common,
      cohortId: options.origin.cohortId, generation: 1, restorationBinding: "origin"
    });
    return { source, target };
  }

  public async read(options: {
    readonly cohortId: string;
    readonly generation: 1 | 2;
    readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
    readonly revision?: string;
  }): Promise<AuthorityProjection> {
    if (options.revision !== undefined && !GIT_SHA.test(options.revision)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_AUTHORITY_REVISION_INVALID",
        "Authority revision must be one nonzero lowercase Git SHA."
      );
    }
    const revision = await resolveAuthorityRevision(this.#fetcher);
    if (options.revision !== undefined && options.revision !== revision) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_AUTHORITY_REVISION_STALE",
        "Requested authority revision is not the current protected main revision."
      );
    }
    const registry = await readAuthorityRegistry(this.#fetcher, revision);
    return projectQualifiedCohortAuthority({ ...options, registry, revision });
  }
}

export const githubCohortAuthorityReader =
  Object.freeze(new GitHubCohortAuthorityReader());
