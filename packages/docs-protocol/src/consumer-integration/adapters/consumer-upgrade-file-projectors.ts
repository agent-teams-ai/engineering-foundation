import { applyEdits, modify } from "jsonc-parser";
import { isMap, isScalar, isSeq, parseDocument, type Scalar, type YAMLSeq } from "yaml";

import type {
  QualifiedDocsCohortBindingV1
} from "../domain/model.js";
import {
  assertConsumerIntegrationProfileSchema
} from "./consumer-integration-schema-validator.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { parseJsonRecord } from "./strict-json-record.js";

const DOCS_PACKAGE = "@agent-teams/docs-protocol";
const FOUNDATION_PACKAGE = "@agent-teams/engineering-foundation";

function decode(bytes: Uint8Array, subject: string): string {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.startsWith("\uFEFF") || source.includes("\u0000")) {
      throw new TypeError(`${subject} contains a BOM or NUL byte.`);
    }
    return source;
  } catch {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_INPUT_INVALID",
      `${subject} must be strict UTF-8 without a BOM or NUL bytes.`
    );
  }
}

function formatting(source: string) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const indent = source.match(/\n([\t ]+)"/u)?.[1] ?? "  ";
  return {
    eol,
    insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : indent.length
  };
}

export async function projectConsumerIntegrationProfileV1(input: {
  readonly bytes: Uint8Array;
  readonly cohort: QualifiedDocsCohortBindingV1;
}): Promise<Uint8Array> {
  const source = decode(input.bytes, "Consumer integration profile");
  const profile = parseJsonRecord(source);
  await assertConsumerIntegrationProfileSchema(profile);
  const edits = modify(source, ["cohort"], input.cohort, {
    formattingOptions: formatting(source)
  });
  if (edits.length === 0) {return Buffer.from(source, "utf8");}
  const postimage = applyEdits(source, edits);
  await assertConsumerIntegrationProfileSchema(parseJsonRecord(postimage));
  return Buffer.from(postimage, "utf8");
}

function managedPackageName(value: string): string | undefined {
  if (value === DOCS_PACKAGE || value.startsWith(`${DOCS_PACKAGE}@`)) {return DOCS_PACKAGE;}
  if (value === FOUNDATION_PACKAGE || value.startsWith(`${FOUNDATION_PACKAGE}@`)) {
    return FOUNDATION_PACKAGE;
  }
  return undefined;
}

function exactExclusions(cohort: QualifiedDocsCohortBindingV1) {
  return new Map([
    [FOUNDATION_PACKAGE, `${FOUNDATION_PACKAGE}@${cohort.packages.engineeringFoundation.version}`],
    [DOCS_PACKAGE, `${DOCS_PACKAGE}@${cohort.packages.docsProtocol.version}`]
  ]);
}

function scalarItems(sequence: YAMLSeq): readonly Scalar<string>[] {
  const items: Scalar<string>[] = [];
  for (const item of sequence.items) {
    if (!isScalar(item) || typeof item.value !== "string") {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_WORKSPACE_INVALID",
        "pnpm minimumReleaseAgeExclude entries must be strings."
      );
    }
    items.push(item as Scalar<string>);
  }
  return items;
}

export function projectPnpmWorkspaceCohortExclusionsV1(input: {
  readonly bytes: Uint8Array;
  readonly cohort: QualifiedDocsCohortBindingV1;
}): Uint8Array {
  const source = decode(input.bytes, "pnpm-workspace.yaml");
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_WORKSPACE_INVALID",
      "pnpm-workspace.yaml must be one duplicate-free YAML mapping."
    );
  }
  const current = document.get("minimumReleaseAgeExclude", true);
  const hasAgePolicy = document.has("minimumReleaseAge") ||
    document.get("minimumReleaseAgeStrict") === true;
  if (current === undefined && !hasAgePolicy) {return Buffer.from(source, "utf8");}
  if (current !== undefined && !isSeq(current)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_WORKSPACE_INVALID",
      "pnpm minimumReleaseAgeExclude must be one sequence."
    );
  }
  const sequence = current ?? document.createNode([]);
  if (!isSeq(sequence)) {throw new Error("unreachable");}
  if (current === undefined) {document.set("minimumReleaseAgeExclude", sequence);}
  const expected = exactExclusions(input.cohort);
  const seen = new Set<string>();
  for (const item of scalarItems(sequence)) {
    const packageName = managedPackageName(item.value);
    if (packageName === undefined) {continue;}
    if (seen.has(packageName)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_WORKSPACE_INVALID",
        `pnpm minimumReleaseAgeExclude contains duplicate ${packageName} authority.`
      );
    }
    seen.add(packageName);
    item.value = expected.get(packageName)!;
  }
  for (const packageName of [FOUNDATION_PACKAGE, DOCS_PACKAGE]) {
    if (!seen.has(packageName)) {sequence.add(expected.get(packageName)!);}
  }
  return Buffer.from(String(document), "utf8");
}
