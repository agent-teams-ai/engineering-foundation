import { applyEdits, modify } from "jsonc-parser";
import { isMap, isScalar, isSeq, parseDocument, type Scalar, type YAMLSeq } from "yaml";

import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDesiredStateV3,
  ConsumerUpgradeAuthorityV1,
  ConsumerUpgradeAuthorityV2,
  QualifiedDocsCohortBindingV1,
  QualifiedDocsCohortBindingV2
} from "../domain/model.js";
import { qualifiedDocsCohortV2PackageEntries } from
  "../application/policies/qualified-docs-cohort-v2.js";
import {
  assertConsumerIntegrationProfileSchema
} from "./consumer-integration-schema-validator.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { parseJsonRecord } from "./strict-json-record.js";
import { projectPnpmManifestCohortPinsV1 } from "./pnpm-manifest-adapter-v1.js";
import { projectPnpmManifestCohortPinsV2 } from "./pnpm-manifest-adapter-v2.js";

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

function exactExclusionsV2(cohort: QualifiedDocsCohortBindingV2) {
  return new Map(qualifiedDocsCohortV2PackageEntries(cohort).map(({ name, version }) =>
    [name, `${name}@${version}`] as const
  ));
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

/**
 * Builds the temporary workspace policy used only while pnpm replaces the
 * source Cohort lock graph with the target graph. The committed projection
 * remains target-only; this bridge prevents a valid recent source package
 * from becoming time-dependent during lockfile regeneration.
 */
export function projectPnpmWorkspaceMigrationExclusionsV1(input: {
  readonly bytes: Uint8Array;
  readonly source: QualifiedDocsCohortBindingV1;
  readonly target: QualifiedDocsCohortBindingV1;
}): Uint8Array {
  const targetBytes = projectPnpmWorkspaceCohortExclusionsV1({
    bytes: input.bytes,
    cohort: input.target
  });
  const source = decode(targetBytes, "pnpm-workspace.yaml");
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents)) {throw new Error("unreachable");}
  const current = document.get("minimumReleaseAgeExclude", true);
  const hasAgePolicy = document.has("minimumReleaseAge") ||
    document.get("minimumReleaseAgeStrict") === true;
  if (current === undefined && !hasAgePolicy) {return targetBytes;}
  if (!isSeq(current)) {throw new Error("unreachable");}
  const existing = new Set(scalarItems(current).map(({ value }) => value));
  const targetExclusions = exactExclusions(input.target);
  for (const [packageName, exclusion] of exactExclusions(input.source)) {
    if (exclusion !== targetExclusions.get(packageName) && !existing.has(exclusion)) {
      current.add(exclusion);
      existing.add(exclusion);
    }
  }
  return Buffer.from(String(document), "utf8");
}

function projectPnpmWorkspaceExclusions(input: {
  readonly bytes: Uint8Array;
  readonly expected: ReadonlyMap<string, string>;
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
  const seen = new Set<string>();
  for (const item of scalarItems(sequence)) {
    const packageName = [...input.expected.keys()].find((name) =>
      item.value === name || item.value.startsWith(`${name}@`)
    );
    if (packageName === undefined) {continue;}
    if (seen.has(packageName)) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_WORKSPACE_INVALID",
        `pnpm minimumReleaseAgeExclude contains duplicate ${packageName} authority.`
      );
    }
    seen.add(packageName);
    item.value = input.expected.get(packageName)!;
  }
  for (const [packageName, exclusion] of input.expected) {
    if (!seen.has(packageName)) {sequence.add(exclusion);}
  }
  return Buffer.from(String(document), "utf8");
}

export function projectPnpmWorkspaceCohortExclusionsV2(input: {
  readonly bytes: Uint8Array;
  readonly cohort: QualifiedDocsCohortBindingV2;
}): Uint8Array {
  return projectPnpmWorkspaceExclusions({
    bytes: input.bytes,
    expected: exactExclusionsV2(input.cohort)
  });
}

export function projectPnpmWorkspaceMigrationExclusionsV2(input: {
  readonly bytes: Uint8Array;
  readonly source: QualifiedDocsCohortBindingV2;
  readonly target: QualifiedDocsCohortBindingV2;
}): Uint8Array {
  const targetBytes = projectPnpmWorkspaceCohortExclusionsV2({
    bytes: input.bytes,
    cohort: input.target
  });
  const source = decode(targetBytes, "pnpm-workspace.yaml");
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents)) {throw new Error("unreachable");}
  const current = document.get("minimumReleaseAgeExclude", true);
  const hasAgePolicy = document.has("minimumReleaseAge") ||
    document.get("minimumReleaseAgeStrict") === true;
  if (current === undefined && !hasAgePolicy) {return targetBytes;}
  if (!isSeq(current)) {throw new Error("unreachable");}
  const existing = new Set(scalarItems(current).map(({ value }) => value));
  const targetExclusions = exactExclusionsV2(input.target);
  for (const [packageName, exclusion] of exactExclusionsV2(input.source)) {
    if (exclusion !== targetExclusions.get(packageName) && !existing.has(exclusion)) {
      current.add(exclusion);
      existing.add(exclusion);
    }
  }
  return Buffer.from(String(document), "utf8");
}

export type ConsumerUpgradeFileProjectionInput =
  | {
      readonly authority: ConsumerUpgradeAuthorityV1;
      readonly current: ConsumerIntegrationDesiredStateV1;
      readonly manifest: Uint8Array;
      readonly profile: Uint8Array;
      readonly workspace?: Uint8Array;
    }
  | {
      readonly authority: ConsumerUpgradeAuthorityV2;
      readonly current: ConsumerIntegrationDesiredStateV3;
      readonly manifest: Uint8Array;
      readonly profile: Uint8Array;
      readonly workspace?: Uint8Array;
    };

export interface ConsumerUpgradeFileProjection {
  readonly manifest: Uint8Array;
  readonly migrationWorkspace?: Uint8Array;
  readonly profile: Uint8Array;
  readonly targetWorkspace?: Uint8Array;
}

export async function projectConsumerUpgradeFiles(
  input: ConsumerUpgradeFileProjectionInput
): Promise<ConsumerUpgradeFileProjection> {
  if (input.current.schemaVersion === 1 && input.authority.cohort.schemaVersion === 1) {
    const targetWorkspace = input.workspace === undefined ? undefined :
      projectPnpmWorkspaceCohortExclusionsV1({
        bytes: input.workspace,
        cohort: input.authority.cohort
      });
    return {
      profile: await projectConsumerIntegrationProfileV1({
        bytes: input.profile,
        cohort: input.authority.cohort
      }),
      manifest: projectPnpmManifestCohortPinsV1({
        bytes: input.manifest,
        cohort: input.authority.cohort
      }),
      ...(targetWorkspace === undefined ? {} : {
        targetWorkspace,
        migrationWorkspace: projectPnpmWorkspaceMigrationExclusionsV1({
          bytes: input.workspace!,
          source: input.current.cohort,
          target: input.authority.cohort
        })
      })
    };
  }
  if (input.current.schemaVersion === 3 && input.authority.cohort.schemaVersion === 2) {
    const targetWorkspace = input.workspace === undefined ? undefined :
      projectPnpmWorkspaceCohortExclusionsV2({
        bytes: input.workspace,
        cohort: input.authority.cohort
      });
    return {
      profile: await projectConsumerIntegrationProfileV3({
        bytes: input.profile,
        cohort: input.authority.cohort
      }),
      manifest: projectPnpmManifestCohortPinsV2({
        bytes: input.manifest,
        cohort: input.authority.cohort
      }),
      ...(targetWorkspace === undefined ? {} : {
        targetWorkspace,
        migrationWorkspace: projectPnpmWorkspaceMigrationExclusionsV2({
          bytes: input.workspace!,
          source: input.current.cohort,
          target: input.authority.cohort
        })
      })
    };
  }
  throw new ConsumerIntegrationNodeError(
    "DOCS_CONSUMER_UPGRADE_GENERATION_MISMATCH",
    "Cross-generation consumer file projection is forbidden."
  );
}
