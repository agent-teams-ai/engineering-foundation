import type {
  ConsumerIntegrationDigest,
  ConsumerIntegrationFileObservation
} from "../domain/model.js";
import type {
  AgentsRoutePlanV1,
  AgentsRoutePlannerV1
} from "../application/ports/consumer-integration-planners.js";
import {
  canonicalManagedRoute,
  digestBytes,
  MANAGED_ROUTE_BEGIN,
  MANAGED_ROUTE_END
} from "../application/policies/consumer-integration-assets.js";

export type { AgentsRoutePlanV1 } from "../application/ports/consumer-integration-planners.js";

function conflict(
  currentDigest: ConsumerIntegrationDigest,
  message: string
): AgentsRoutePlanV1 {
  return {
    state: "conflict",
    currentDigest,
    expectedDigest: currentDigest,
    issues: [{
      code: "DOCS_CONSUMER_AGENTS_ROUTE_CONFLICT",
      severity: "error",
      subject: "AGENTS.md",
      message
    }]
  };
}

function decodeAgentsSource(bytes: Uint8Array): string {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.includes("\u0000") || source.startsWith("\uFEFF") || source.normalize("NFC") !== source) {
    throw new TypeError("AGENTS.md must be NFC UTF-8 text without BOM or NUL bytes.");
  }
  if (source.includes("\r\n") && source.replaceAll("\r\n", "").includes("\n")) {
    throw new TypeError("AGENTS.md must not mix LF and CRLF line endings.");
  }
  return source;
}

export function planAgentsRouteV1(input: {
  readonly observation: ConsumerIntegrationFileObservation;
  readonly skillPath: string;
  readonly knownPriorRouteDigest?: ConsumerIntegrationDigest;
}): AgentsRoutePlanV1 {
  if (input.observation.state === "absent") {
    const empty = digestBytes(new Uint8Array());
    const postimage = Buffer.from(`${canonicalManagedRoute(input.skillPath)}\n`, "utf8");
    return {
      state: "absent",
      currentDigest: empty,
      expectedDigest: digestBytes(postimage),
      postimage,
      issues: []
    };
  }
  const bytes = Buffer.from(input.observation.bytes);
  const currentDigest = digestBytes(bytes);
  let source: string;
  try {
    source = decodeAgentsSource(bytes);
  } catch (error) {
    return conflict(
      currentDigest,
      error instanceof Error ? error.message : "AGENTS.md must be valid UTF-8 text."
    );
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const normalized = source.replaceAll("\r\n", "\n");
  const targetBlock = canonicalManagedRoute(input.skillPath);
  const beginCount = normalized.split(MANAGED_ROUTE_BEGIN).length - 1;
  const endCount = normalized.split(MANAGED_ROUTE_END).length - 1;
  let next: string;
  if (beginCount === 1 && endCount === 1) {
    const begin = normalized.indexOf(MANAGED_ROUTE_BEGIN);
    const end = normalized.indexOf(MANAGED_ROUTE_END, begin) + MANAGED_ROUTE_END.length;
    if (begin < 0 || end < begin) {
      return conflict(currentDigest, "The managed documentation route block is malformed.");
    }
    const currentBlock = normalized.slice(begin, end);
    if (currentBlock !== targetBlock &&
      digestBytes(Buffer.from(currentBlock, "utf8")) !== input.knownPriorRouteDigest) {
      return conflict(currentDigest, "The managed documentation route block contains unknown local changes.");
    }
    next = `${normalized.slice(0, begin)}${targetBlock}${normalized.slice(end)}`;
  } else if (beginCount !== 0 || endCount !== 0) {
    return conflict(currentDigest, "AGENTS.md contains duplicate or incomplete managed route markers.");
  } else {
    const legacy = `Use [${input.skillPath}](${input.skillPath}) for documentation.`;
    const legacyCount = normalized.split(legacy).length - 1;
    const mentions = normalized.split("\n").filter((line) => line.includes("docs-authoring/SKILL.md"));
    if (legacyCount === 1 && mentions.length === 1) {
      next = normalized.replace(legacy, targetBlock);
    } else if (mentions.length > 0) {
      return conflict(currentDigest, "AGENTS.md contains an unknown documentation Skill route.");
    } else {
      const separator = normalized.endsWith("\n\n") ? "" : normalized.endsWith("\n") ? "\n" : "\n\n";
      next = `${normalized}${separator}${targetBlock}\n`;
    }
  }
  const postimage = Buffer.from(next.replaceAll("\n", eol), "utf8");
  const expectedDigest = digestBytes(postimage);
  if (expectedDigest === currentDigest) {
    return { state: "exact-current", currentDigest, expectedDigest, issues: [] };
  }
  return {
    state: "known-prior",
    currentDigest,
    expectedDigest,
    postimage,
    issues: []
  };
}

export const agentsRoutePlannerV1: AgentsRoutePlannerV1 = Object.freeze({
  plan: planAgentsRouteV1
});
