/** Feature-private profile projection helpers; no package export or graph node. */
import {
  assertConsumerIntegrationProfileSchema
} from "./consumer-integration-schema-validator.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { parseJsonRecord } from "./strict-json-record.js";
import { applyEdits, modify } from "jsonc-parser";

import type {
  ManagedSuccessorSelectionV3,
  QualifiedDocsCohortBindingV1,
  QualifiedDocsCohortBindingV2
} from "../application-api.js";

export function decode(bytes: Uint8Array, subject: string): string {
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

export async function projectConsumerIntegrationProfileV3(input: {
  readonly bytes: Uint8Array;
  readonly cohort: QualifiedDocsCohortBindingV2;
}): Promise<Uint8Array> {
  const source = decode(input.bytes, "Consumer integration profile");
  const profile = parseJsonRecord(source);
  if (profile["schemaVersion"] !== 3) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_GENERATION_MISMATCH",
      "A Cohort v2 upgrade requires one explicit consumer integration profile v3."
    );
  }
  await assertConsumerIntegrationProfileSchema(profile);
  const edits = modify(source, ["cohort"], input.cohort, {
    formattingOptions: formatting(source)
  });
  if (edits.length === 0) {return Buffer.from(source, "utf8");}
  const postimage = applyEdits(source, edits);
  await assertConsumerIntegrationProfileSchema(parseJsonRecord(postimage));
  return Buffer.from(postimage, "utf8");
}

export async function projectConsumerIntegrationProfileV4(input: {
  readonly bytes: Uint8Array;
  readonly selection: ManagedSuccessorSelectionV3;
}): Promise<Uint8Array> {
  const source = decode(input.bytes, "Consumer integration profile");
  const profile = parseJsonRecord(source);
  if (profile["schemaVersion"] !== 3) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_GENERATION_MISMATCH",
      "A Cohort v3 upgrade requires one explicit consumer integration profile v3 source."
    );
  }
  await assertConsumerIntegrationProfileSchema(profile);
  const edits = [
    ...modify(source, ["schemaVersion"], 4, { formattingOptions: formatting(source) }),
    ...modify(source, ["cohort"], input.selection.profile.cohort, { formattingOptions: formatting(source) })
  ];
  const postimage = applyEdits(source, edits);
  await assertConsumerIntegrationProfileSchema(parseJsonRecord(postimage));
  return Buffer.from(postimage, "utf8");
}

export async function migrateHistoricalConsumerIntegrationProfileToV3(input: {
  readonly bytes: Uint8Array;
  readonly cohort: QualifiedDocsCohortBindingV2;
}): Promise<Uint8Array> {
  let source = decode(input.bytes, "Consumer integration profile");
  const profile = parseJsonRecord(source);
  if (profile["schemaVersion"] !== 1 && profile["schemaVersion"] !== 2) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_GENERATION_MISMATCH",
      "Explicit Cohort v1-to-v2 migration requires one historical profile v1 or v2 source."
    );
  }
  await assertConsumerIntegrationProfileSchema(profile);
  for (const [path, value] of [
    [["schemaVersion"], 3],
    [["qualification"], {
      contractPath: "architecture/foundation/docs-protocol-qualification.json",
      gateCommand: "pnpm docs:protocol:check"
    }],
    [["cohort"], input.cohort]
  ] as const) {
    source = applyEdits(source, modify(source, [...path], value, {
      formattingOptions: formatting(source)
    }));
  }
  await assertConsumerIntegrationProfileSchema(parseJsonRecord(source));
  return Buffer.from(source, "utf8");
}
