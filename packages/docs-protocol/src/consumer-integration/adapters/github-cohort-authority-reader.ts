import type {
  ConsumerUpgradeAuthorityReader
} from "../application/ports/consumer-upgrade.js";
import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerUpgradeAuthorityV1,
  QualifiedDocsCohortBindingV1
} from "../domain/model.js";
import {
  assertQualifiedDocsCohortBindingV1
} from "../application/policies/consumer-integration-desired-state.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { parseJsonRecord } from "./strict-json-record.js";

const AUTHORITY_REPOSITORY = "agent-teams-ai/.github";
const AUTHORITY_PATH = "governance/docs-qualified-cohorts.json";
const AUTHORITY_API = `https://api.github.com/repos/${AUTHORITY_REPOSITORY}`;
const AUTHORITY_RAW = `https://raw.githubusercontent.com/${AUTHORITY_REPOSITORY}`;
const GIT_SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
const MAXIMUM_AUTHORITY_BYTES = 8 * 1024 * 1024;
const MANAGED_PACKAGES = [
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
): { readonly qualificationEventDigest: string; readonly state: string } {
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
    state: string(last.event["state"], "Current Cohort lifecycle state")
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

function packageProjection(source: Record<string, unknown>) {
  const entries = array(source["packages"], "Cohort packages")
    .map((value) => record(value, "Cohort package"));
  const packageByName = new Map(entries.map((entry) => [entry["name"], entry]));
  if (entries.length !== MANAGED_PACKAGES.length ||
    packageByName.size !== MANAGED_PACKAGES.length ||
    MANAGED_PACKAGES.some((name) => !packageByName.has(name))) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_AUTHORITY_INVALID",
      "Qualified Cohort must select exactly the two managed packages."
    );
  }
  const docs = packageByName.get(MANAGED_PACKAGES[0])!;
  const foundation = packageByName.get(MANAGED_PACKAGES[1])!;
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

function cohortProjection(
  source: Record<string, unknown>,
  qualificationEventDigest: string
): QualifiedDocsCohortBindingV1 {
  const workflow = record(source["reusable_workflow"], "Cohort reusable workflow");
  const assets = record(source["assets"], "Cohort assets");
  const skill = record(assets["skill"], "Cohort Skill asset");
  const caller = record(assets["caller_workflow"], "Cohort caller workflow asset");
  const assetCatalog = record(assets["asset_catalog"], "Cohort asset catalog");
  const transitionCatalog = record(assets["transition_catalog"], "Cohort transition catalog");
  const runtime = record(source["runtime"], "Cohort runtime");
  const runtimeClosure = record(source["runtime_closure"], "Cohort runtime closure");
  const schemas = record(source["schemas"], "Cohort schemas");
  const projection = {
    schemaVersion: 1 as const,
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
    packages: packageProjection(source),
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
  } as unknown as QualifiedDocsCohortBindingV1;
  assertQualifiedDocsCohortBindingV1(projection);
  return Object.freeze(projection);
}

export function projectQualifiedCohortAuthority(input: {
  readonly cohortId: string;
  readonly registry: Record<string, unknown>;
  readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
  readonly revision: string;
}): ConsumerUpgradeAuthorityV1 {
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
  const lifecycle = selectedLifecycleState(
    array(input.registry["events"], "Cohort lifecycle events"),
    input.cohortId
  );
  assertSelectable(source, lifecycle.state, input.repository);
  return Object.freeze({
    repository: AUTHORITY_REPOSITORY,
    path: AUTHORITY_PATH,
    revision: input.revision,
    cohort: cohortProjection(source, lifecycle.qualificationEventDigest)
  });
}

export class GitHubCohortAuthorityReader implements ConsumerUpgradeAuthorityReader {
  readonly #fetcher: AuthorityFetch;

  public constructor(fetcher: AuthorityFetch = globalThis.fetch) {
    this.#fetcher = fetcher;
  }

  public async read(options: {
    readonly cohortId: string;
    readonly repository: ConsumerIntegrationDesiredStateV1["repository"];
    readonly revision?: string;
  }): Promise<ConsumerUpgradeAuthorityV1> {
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

export const githubCohortAuthorityReader: ConsumerUpgradeAuthorityReader =
  Object.freeze(new GitHubCohortAuthorityReader());
