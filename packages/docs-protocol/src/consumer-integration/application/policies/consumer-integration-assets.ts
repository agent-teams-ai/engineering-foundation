import { createHash } from "node:crypto";

import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDigest,
  QualifiedDocsCohortBindingV1
} from "../../domain/model.js";
import {
  GENERATED_CALLER_WORKFLOW_TEMPLATE,
  GENERATED_DOCS_SKILL,
  GENERATED_DOCS_SKILL_V2,
  GENERATED_TRANSITION_CATALOG
} from "../../generated/canonical-assets.js";

const CATALOG_SOURCE = Object.freeze({
  skill: GENERATED_DOCS_SKILL_V2,
  callerWorkflowTemplate: GENERATED_CALLER_WORKFLOW_TEMPLATE
});
const LEGACY_CATALOG_SOURCE = Object.freeze({ skill: GENERATED_DOCS_SKILL });

export const CANONICAL_DOCS_SKILL = LEGACY_CATALOG_SOURCE.skill;
export const CANONICAL_DOCS_SKILL_V2 = CATALOG_SOURCE.skill;
export const CANONICAL_CALLER_WORKFLOW_TEMPLATE = CATALOG_SOURCE.callerWorkflowTemplate;

export const BOOTSTRAP_KNOWN_PRIOR_DOCS_SKILLS: readonly Uint8Array[] = Object.freeze([
  Buffer.from(CANONICAL_DOCS_SKILL, "utf8"),
  Buffer.from(CANONICAL_DOCS_SKILL_V2
    .replace(
      "--type TYPE --id ID --title TITLE --owner OWNER --summary SUMMARY --dry-run",
      "--type TYPE --id ID --dry-run"
    )
    .replace(
      "--type TYPE --id ID --title TITLE --owner OWNER --summary SUMMARY --apply",
      "--type TYPE --id ID --apply"
    )
    .replace("- For edits, preserve canonical frontmatter and sidecar ownership; use the repository's governed review flow rather than bypassing the create-only writer.\n", "")
    .replace("- For accepted authority, record supersession explicitly instead of silently rewriting history.\n", "")
    .replace("- Finish with the full consumer gate `pnpm docs:protocol:check` after the index is current.", "- Finish with `pnpm docs:check` after the index is current.")
    .replace("## Rules\n- Never invent", "## Rules\n\n- Never invent")
    .replace("- If dependencies are absent, use only `pnpm install --frozen-lockfile`; never use npx, dlx, or latest tags.\n", ""),
  "utf8")
]);

export const MANAGED_ROUTE_BEGIN = "<!-- agent-teams-docs:route/v1 begin -->";
export const MANAGED_ROUTE_END = "<!-- agent-teams-docs:route/v1 end -->";

const BOOTSTRAP_WORKFLOW_REVISION = "2679c8bc1e432091271d2f68ef904694e4d5838e";

export const BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS: readonly Uint8Array[] = Object.freeze([
  Buffer.from(`name: Documentation Protocol

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  docs-protocol:
    uses: agent-teams-ai/.github/.github/workflows/docs-protocol-check.yml@${BOOTSTRAP_WORKFLOW_REVISION}
`, "utf8")
]);

export interface KnownPriorCohortCatalogEntryV1 {
  readonly cohort: QualifiedDocsCohortBindingV1;
  readonly skill: Uint8Array;
  readonly callerWorkflow: Uint8Array;
  readonly agentsRouteDigest: ConsumerIntegrationDigest;
  readonly docsScriptsDigest: ConsumerIntegrationDigest;
}

export interface CurrentSourceExecutorV1 {
  readonly packages: QualifiedDocsCohortBindingV1["packages"];
  readonly schemas: QualifiedDocsCohortBindingV1["schemas"];
  readonly runtime: QualifiedDocsCohortBindingV1["runtime"];
  readonly assetCatalogDigest: ConsumerIntegrationDigest;
  readonly skillDigest: ConsumerIntegrationDigest;
  readonly callerWorkflowDigest: ConsumerIntegrationDigest;
  readonly agentsRouteDigest: ConsumerIntegrationDigest;
  readonly docsScriptsDigest: ConsumerIntegrationDigest;
  readonly directTargetCohortIds: readonly string[];
}

export interface ConsumerAssetCatalogV1 {
  readonly catalogDigest: ConsumerIntegrationDigest;
  readonly transitionCatalogDigest: ConsumerIntegrationDigest;
  readonly currentSourceExecutors: readonly CurrentSourceExecutorV1[];
  readonly directTargetBundles: readonly KnownPriorCohortCatalogEntryV1[];
}

export const BUNDLED_KNOWN_PRIOR_COHORTS: readonly KnownPriorCohortCatalogEntryV1[] =
  Object.freeze([]);
export const BUNDLED_CURRENT_SOURCE_EXECUTORS: readonly CurrentSourceExecutorV1[] =
  Object.freeze([]);

export const CANONICAL_TRANSITION_CATALOG = GENERATED_TRANSITION_CATALOG;

export const CANONICAL_ASSET_CATALOG = `${canonicalConsumerIntegrationJson({
  schemaVersion: 1,
  skillPath: "skills/docs/SKILL.md",
  skillDigest: digestBytes(Buffer.from(CATALOG_SOURCE.skill, "utf8")),
  callerWorkflowTemplatePath: "assets/docs-protocol.yml",
  callerWorkflowTemplateDigest: digestBytes(Buffer.from(
    CATALOG_SOURCE.callerWorkflowTemplate,
    "utf8"
  )),
  routeTemplate: canonicalManagedRoute("{skillPath}"),
  scriptsTemplate: canonicalDocsScripts("{profilePath}"),
})}\n`;

export function isBootstrapKnownPriorCallerWorkflow(bytes: Uint8Array): boolean {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (source.normalize("NFC") !== source || source.includes("\u0000") || source.includes("\r")) {
    return false;
  }
  const escapedRevision = BOOTSTRAP_WORKFLOW_REVISION.replaceAll("-", "\\-");
  const match = new RegExp(
    `^name: Documentation Protocol\\n\\non:\\n  pull_request:\\n  push:\\n    branches:\\n      - ([A-Za-z0-9._/-]+)\\n\\npermissions:\\n  contents: read\\n\\njobs:\\n  docs-protocol:\\n    uses: agent-teams-ai/\\.github/\\.github/workflows/docs-protocol-check\\.yml@${escapedRevision}\\n$`,
    "u"
  ).exec(source);
  const branch = match?.[1];
  return branch !== undefined && !branch.startsWith("/") && !branch.endsWith("/") &&
    !branch.includes("..") && !branch.includes("//");
}

export function digestBytes(value: Uint8Array): ConsumerIntegrationDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalCallerWorkflow(cohort: QualifiedDocsCohortBindingV1): string {
  return CANONICAL_CALLER_WORKFLOW_TEMPLATE
    .replace("{{REUSABLE_WORKFLOW_REPOSITORY}}", cohort.workflow.repository)
    .replace("{{REUSABLE_WORKFLOW_PATH}}", cohort.workflow.path)
    .replace("{{REUSABLE_WORKFLOW_REVISION}}", cohort.workflow.revision);
}

export function canonicalDocsScriptsDigest(profilePath: string): ConsumerIntegrationDigest {
  return digestBytes(Buffer.from(canonicalConsumerIntegrationJson(
    canonicalDocsScripts(profilePath)
  ), "utf8"));
}

export function canonicalManagedRoute(skillPath: string): string {
  return `${MANAGED_ROUTE_BEGIN}
Use [${skillPath}](${skillPath}) for documentation.
${MANAGED_ROUTE_END}`;
}

export function canonicalDocsScripts(profilePath: string): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    ["check", "doctor", "find", "info", "new", "recover"].map((command) => [
      `docs:${command}`,
      `agent-teams-docs ${command} --consumer . --profile ${profilePath}`
    ])
  ));
}

export function canonicalConsumerIntegrationJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Managed state contains a non-canonical number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalConsumerIntegrationJson).join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError("Managed state contains a non-JSON value.");
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalConsumerIntegrationJson(entry)}`)
    .join(",")}}`;
}

export function canonicalManagedState(
  desired: ConsumerIntegrationDesiredStateV1,
  assets: {
    readonly skillDigest: ConsumerIntegrationDigest;
    readonly callerWorkflowDigest: ConsumerIntegrationDigest;
    readonly assetCatalogDigest: ConsumerIntegrationDigest;
    readonly transitionCatalogDigest: ConsumerIntegrationDigest;
    readonly agentsRouteDigest: ConsumerIntegrationDigest;
    readonly docsScriptsDigest: ConsumerIntegrationDigest;
  }
): string {
  const body = {
    schemaVersion: 1,
    cohortId: desired.cohort.cohortId,
    cohortAuthority: {
      channel: desired.cohort.channel,
      recordDigest: desired.cohort.recordDigest,
      qualificationEventDigest: desired.cohort.qualificationEventDigest,
      eligibleAfter: desired.cohort.eligibleAfter,
      upgradeFrom: desired.cohort.upgradeFrom,
      rollbackTo: desired.cohort.rollbackTo
    },
    repository: desired.repository,
    packages: desired.cohort.packages,
    schemas: desired.cohort.schemas,
    runtime: desired.cohort.runtime,
    profilePath: desired.profilePath,
    skillPath: desired.skillPath,
    callerWorkflowPath: desired.callerWorkflowPath,
    managedStatePath: desired.managedStatePath,
    assets
  };
  const stateDigest = digestBytes(Buffer.from(
    canonicalConsumerIntegrationJson({
      domain: "agent-teams.docs-protocol.managed-state/v1",
      body
    }),
    "utf8"
  ));
  return `${canonicalConsumerIntegrationJson({ ...body, stateDigest })}\n`;
}

export function describeCanonicalConsumerAssets(cohort: QualifiedDocsCohortBindingV1): {
  readonly skillDigest: ConsumerIntegrationDigest;
  readonly callerWorkflowDigest: ConsumerIntegrationDigest;
  readonly assetCatalogDigest: ConsumerIntegrationDigest;
  readonly transitionCatalogDigest: ConsumerIntegrationDigest;
} {
  const skillDigest = digestBytes(Buffer.from(CANONICAL_DOCS_SKILL_V2, "utf8"));
  const callerWorkflowDigest = digestBytes(Buffer.from(canonicalCallerWorkflow(cohort), "utf8"));
  const assetCatalogDigest = digestBytes(Buffer.from(CANONICAL_ASSET_CATALOG, "utf8"));
  return Object.freeze({
    skillDigest,
    callerWorkflowDigest,
    assetCatalogDigest,
    transitionCatalogDigest: digestBytes(Buffer.from(CANONICAL_TRANSITION_CATALOG, "utf8"))
  });
}
