import { createHash } from "node:crypto";

import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDigest,
  QualifiedDocsCohortV1
} from "../../domain/model.js";

export const CANONICAL_DOCS_SKILL = `---
name: docs-authoring
description: Use when creating, changing, reorganizing, or reviewing governed documentation in this repository.
---

# Documentation Authoring

Protocol: \`agent-teams.docs-protocol/v1\`.

## Required workflow

- Read the current types, owners, placement, metadata, and index policy with \`pnpm docs:info\`.
- Search first with \`pnpm docs:find -- --text query\`.
- Reuse or relate existing authority instead of creating a competing source.
- Preview with \`pnpm docs:new -- --type TYPE --id ID --dry-run\`.
- Review the exact destination, metadata, relations, anchors, and diagnostics.
- Apply with \`pnpm docs:new -- --type TYPE --id ID --apply\` after review.
- Manually update the reported index/link exactly when reachability requires it.
- Finish with \`pnpm docs:check\` after the index is current.

## Rules

- Never invent owners, types, statuses, paths, or metadata outside \`docs:info\`.
- Keep preview and apply inputs identical.
- Stop when recovery is required; use \`pnpm docs:doctor\` before \`pnpm docs:recover\`.
- Resolve required anchors and blockers before apply.
- Do not bypass repository scripts or hand-edit transaction evidence.
`;

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

export function digestBytes(value: Uint8Array): ConsumerIntegrationDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalCallerWorkflow(cohort: QualifiedDocsCohortV1): string {
  return `name: Documentation Protocol

on:
  pull_request:
  push:

permissions:
  contents: read

jobs:
  docs-protocol:
    uses: ${cohort.workflow.repository}/${cohort.workflow.path}@${cohort.workflow.revision}
`;
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
    readonly agentsRouteDigest: ConsumerIntegrationDigest;
    readonly docsScriptsDigest: ConsumerIntegrationDigest;
  }
): string {
  const body = {
    schemaVersion: 1,
    cohortId: desired.cohort.cohortId,
    repository: desired.repository,
    packages: desired.cohort.packages,
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

export function describeCanonicalConsumerAssets(cohort: QualifiedDocsCohortV1): {
  readonly skillDigest: ConsumerIntegrationDigest;
  readonly callerWorkflowDigest: ConsumerIntegrationDigest;
  readonly assetCatalogDigest: ConsumerIntegrationDigest;
} {
  const skillDigest = digestBytes(Buffer.from(CANONICAL_DOCS_SKILL, "utf8"));
  const callerWorkflowDigest = digestBytes(Buffer.from(canonicalCallerWorkflow(cohort), "utf8"));
  const assetCatalogDigest = digestBytes(Buffer.from(canonicalConsumerIntegrationJson({
    schemaVersion: 1,
    current: {
      skillDigest,
      callerWorkflowDigest,
      routeTemplateDigest: digestBytes(Buffer.from(canonicalManagedRoute("{skillPath}"), "utf8")),
      scriptsTemplateDigest: canonicalDocsScriptsDigest("{profilePath}")
    },
    knownPriorCallerWorkflowDigests: BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS
      .map(digestBytes)
      .toSorted()
  }), "utf8"));
  return Object.freeze({
    skillDigest,
    callerWorkflowDigest,
    assetCatalogDigest
  });
}
