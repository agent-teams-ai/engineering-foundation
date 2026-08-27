import type { DocsCommandEnvelope } from "../domain/model.js";

function reachabilitySummary(value: unknown): string {
  const reachability = value as Record<string, unknown>;
  return [reachability["kind"], reachability["indexPath"], reachability["reason"]]
    .filter((entry) => typeof entry === "string")
    .join(" ");
}

function display(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function renderInfo(result: Record<string, unknown>): readonly string[] {
  const lines = [`Project: ${display(result["projectId"])}`];
  lines.push(`Foundation profile: ${JSON.stringify(result["foundationProfile"] ?? {})}`);
  lines.push(`Authority paths: ${(result["authorityPaths"] as unknown[] | undefined)?.join(",") ?? "unknown"}`);
  lines.push(`Catalog: ${JSON.stringify(result["catalog"] ?? {})}`);
  lines.push(`Metadata schema: ${display(result["metadataSchemaPath"])} | sidecar ${JSON.stringify(result["metadataSidecar"] ?? {})}`);
  lines.push(`Owners: ${(result["ownerIds"] as unknown[] | undefined)?.join(",") ?? "none"}`);
  for (const value of Array.isArray(result["types"]) ? result["types"] : []) {
    const type = value as Record<string, unknown>;
    const identity = type["identity"] as Record<string, unknown>;
    const placement = type["placement"] as Record<string, unknown>;
    const template = type["template"] as Record<string, unknown> | undefined;
    lines.push(`Type ${String(type["type"])} | initial ${String(type["initialStatus"])} | owners ${(type["allowedOwnerIds"] as unknown[]).join(",")} | identity ${display(identity["format"] ?? identity["kind"])} | placement ${display(placement["kind"])} | identityDetails ${JSON.stringify(identity)} | placementDetails ${JSON.stringify(placement)} | template ${display(template?.["path"])} | required ${(type["requiredMetadata"] as unknown[]).join(",")} | reachability ${reachabilitySummary(type["reachability"])}`);
  }
  lines.push(`Semantic validators: ${(result["semanticValidatorIds"] as unknown[]).join(",") || "none"}`);
  return lines;
}

function renderFind(result: Record<string, unknown>): readonly string[] {
  const lines = [`Matches: ${display(result["matches"], "0")}`];
  for (const value of Array.isArray(result["documents"]) ? result["documents"] : []) {
    const document = value as Record<string, unknown>;
    lines.push(`${String(document["id"])} | ${String(document["type"])} | ${String(document["status"])} | ${String(document["owner"])} | ${String(document["repositoryPath"])} | ${String(document["title"])}`);
  }
  return lines;
}

function renderNew(result: Record<string, unknown>): readonly string[] {
  if (typeof result["documentPath"] !== "string") {return [];}
  const lines = [`Document: ${result["documentPath"]}`];
  const compiled = result["compiled"] as Record<string, unknown> | undefined;
  if (compiled !== undefined) {
    const document = compiled["document"] as Record<string, unknown> | undefined;
    lines.push(`Compiled document:\n${display(document?.["content"], "")}`);
    lines.push(`Compiled frontmatter:\n${display(compiled["frontmatter"], "")}`);
    lines.push(`Compiled metadata: ${JSON.stringify(compiled["metadata"] ?? {})}`);
    lines.push(`Compiled relations: ${JSON.stringify(compiled["relations"] ?? {})}`);
    lines.push(`Compiled anchors: ${JSON.stringify(compiled["anchors"] ?? [])}`);
  }
  const reachability = result["reachability"] as Record<string, unknown> | undefined;
  const indexable = ["preview", "applied", "already-applied"].includes(display(result["writeState"]));
  if (indexable && reachability?.["state"] === "manual-required") {lines.push(`Next: add ${String(reachability["markdownLink"])} to ${String(reachability["indexPath"])}`);}
  if (result["writeState"] === "published-recovery-required") {lines.push("Next: recover the published transaction before editing reachability indexes.");}
  return lines;
}

function renderCommandResult(envelope: DocsCommandEnvelope, result: Record<string, unknown>): readonly string[] {
  switch (envelope.command) {
    case "docs.info": return renderInfo(result);
    case "docs.find": return renderFind(result);
    case "docs.new": return renderNew(result);
    case "docs.doctor": return [
      `Project: ${display(result["projectId"])}`,
      `Environment: ${JSON.stringify(result["environment"] ?? {})}`,
      `Transaction: ${JSON.stringify(result["transaction"] ?? {})}`
    ];
    case "docs.check": return [
      `Project: ${display(result["projectId"])}`,
      `Catalog: ${String(result["catalogStatus"])} (${String(result["documents"])} documents)`,
      `Adoption: ${result["valid"] === true ? "valid" : "invalid"}`
    ];
    case "docs.recover": return [`Recovery: ${display(result["transactionState"])} (${display(result["writeState"])})`];
    default: return [];
  }
}

export function renderDocsHuman(envelope: DocsCommandEnvelope): string {
  const result = envelope.result as Record<string, unknown>;
  const lines = [`${envelope.command}: ${envelope.outcome}`, ...renderCommandResult(envelope, result)];
  for (const diagnostic of envelope.diagnostics) {lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.ruleId}: ${diagnostic.message}`);}
  return `${lines.join("\n")}\n`;
}
