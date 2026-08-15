import { posix } from "node:path";

import {
  DOCS_PROTOCOL_ID,
  DOCS_PROTOCOL_VERSION,
  type DocsProtocolProfile,
  type DocsTypeProfile,
  type ReachabilityAction
} from "./model.js";

const LOWER_ID = /^[a-z0-9][a-z0-9._/-]*$/u;
const REPOSITORY_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/u;

export class DocsProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsProfileError";
  }
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DocsProfileError(`${subject} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], subject: string): void {
  const expected = keys.toSorted();
  const actual = Object.keys(value).toSorted();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new DocsProfileError(`${subject} must contain exactly: ${expected.join(", ")}.`);
  }
}

function lowerId(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160 || !LOWER_ID.test(value)) {
    throw new DocsProfileError(`${subject} is invalid.`);
  }
  return value;
}

function repositoryPath(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !REPOSITORY_PATH.test(value)) {
    throw new DocsProfileError(`${subject} is invalid.`);
  }
  if (Buffer.byteLength(value, "utf8") > 512 || value.split("/").some((segment) => Buffer.byteLength(segment, "utf8") > 255)) {
    throw new DocsProfileError(`${subject} exceeds portable path limits.`);
  }
  return value;
}

function validatorIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new DocsProfileError("profile.semanticValidatorIds must be a bounded array.");
  }
  const entries = value.map((entry, index) => lowerId(entry, `profile.semanticValidatorIds[${index}]`));
  if (new Set(entries).size !== entries.length) {
    throw new DocsProfileError("profile.semanticValidatorIds must not contain duplicates.");
  }
  return Object.freeze(entries.toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
}

export function parseDocsProtocolProfile(value: unknown): DocsProtocolProfile {
  const candidate = record(value, "profile");
  exactKeys(candidate, ["schemaVersion", "protocol", "foundationProfile", "agentWorkflow", "semanticValidatorIds"], "profile");
  if (candidate["schemaVersion"] !== 1) {throw new DocsProfileError("profile.schemaVersion must be 1.");}
  const protocol = record(candidate["protocol"], "profile.protocol");
  exactKeys(protocol, ["id", "version"], "profile.protocol");
  if (protocol["id"] !== DOCS_PROTOCOL_ID || protocol["version"] !== DOCS_PROTOCOL_VERSION) {
    throw new DocsProfileError(`profile.protocol must be ${DOCS_PROTOCOL_ID}/v${DOCS_PROTOCOL_VERSION}.`);
  }
  const foundationProfile = record(candidate["foundationProfile"], "profile.foundationProfile");
  exactKeys(foundationProfile, ["metadataSidecarPolicy", "path", "schemaVersion"], "profile.foundationProfile");
  if (foundationProfile["schemaVersion"] !== 2 || foundationProfile["metadataSidecarPolicy"] !== "foundation-profile-v2-strict-merge") {
    throw new DocsProfileError("profile.foundationProfile must route to Foundation profile v2 strict sidecar merge.");
  }
  const workflow = record(candidate["agentWorkflow"], "profile.agentWorkflow");
  exactKeys(workflow, ["skillPath"], "profile.agentWorkflow");
  return Object.freeze({
    schemaVersion: 1,
    protocol: Object.freeze({ id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION }),
    foundationProfile: Object.freeze({
      metadataSidecarPolicy: "foundation-profile-v2-strict-merge",
      path: repositoryPath(foundationProfile["path"], "profile.foundationProfile.path"),
      schemaVersion: 2
    }),
    agentWorkflow: Object.freeze({ skillPath: repositoryPath(workflow["skillPath"], "profile.agentWorkflow.skillPath") }),
    semanticValidatorIds: validatorIds(candidate["semanticValidatorIds"])
  });
}

function markdownLabel(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\[/gu, "\\[").replace(/\]/gu, "\\]");
}

export function projectReachability(type: DocsTypeProfile, destination: string, heading: string): ReachabilityAction {
  const strategy = type.reachability;
  if (strategy.kind === "not-required") {return Object.freeze({ state: "not-required", reason: strategy.reason });}
  let indexPath: string;
  if (strategy.kind === "manual-fixed-index") {
    indexPath = strategy.indexPath;
  } else {
    if (type.placement.kind !== "explicit") {
      throw new DocsProfileError("Colocated reachability requires explicit Foundation placement authority.");
    }
    const destinationSegments = destination.split("/");
    const requiredSegments = type.placement.requiredSegmentsInOrder;
    const candidates = destinationSegments.flatMap((_segment, start) =>
      requiredSegments.every((segment, offset) => destinationSegments[start + offset] === segment) ? [start] : []
    );
    if (candidates.length !== 1 || candidates[0] === undefined || candidates[0] === 0) {
      throw new DocsProfileError(`Cannot derive one colocated index for ${destination}.`);
    }
    indexPath = `${destinationSegments.slice(0, candidates[0]).join("/")}/${strategy.indexBasename}`;
  }
  const relative = posix.relative(posix.dirname(indexPath), destination);
  if (relative.length === 0) {throw new DocsProfileError("Reachability index cannot equal the document path.");}
  return Object.freeze({ state: "manual-required", indexPath, markdownLink: `[${markdownLabel(heading)}](${relative})` });
}
