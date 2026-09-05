import { applyEdits, modify } from "jsonc-parser";

import { parseJsonRecord, recordField } from "./strict-json-record.js";
import {
  canonicalConsumerIntegrationJson,
  canonicalDocsScripts,
  digestBytes,
  type ConsumerIntegrationDigest,
  type ConsumerIntegrationFileObservation,
  type ConsumerIntegrationIssue,
  type QualifiedDocsCohortBindingV1,
  type PnpmManifestPlanV1
} from "../application-api.js";

const DOCS_PACKAGE = "@agent-teams/docs-protocol";
const FOUNDATION_PACKAGE = "@agent-teams/engineering-foundation";

export interface CohortManifestTarget {
  readonly name: string;
  readonly version: string;
}

export type { PnpmManifestPlanV1 } from "../application-api.js";

function issue(subject: string, code: string, message: string): ConsumerIntegrationIssue {
  return { code, severity: "error", subject, message };
}

function rejectPrototypeKeys(value: unknown, path = "package.json"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      rejectPrototypeKeys(entry, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw new TypeError(`${path}.${key} is forbidden.`);
    }
    rejectPrototypeKeys(entry, `${path}.${key}`);
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

function applyField(source: string, path: readonly (string | number)[], value: unknown): string {
  return applyEdits(source, modify(source, [...path], value, {
    formattingOptions: formatting(source)
  }));
}

function parseManifest(bytes: Uint8Array): {
  readonly manifest: Record<string, unknown>;
  readonly source: string;
} {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.startsWith("\uFEFF")) {
    throw new TypeError("package.json must not contain a UTF-8 BOM.");
  }
  const manifest = parseJsonRecord(source);
  rejectPrototypeKeys(manifest);
  return { manifest, source };
}

function manifestShapeIssues(manifest: Record<string, unknown>): ConsumerIntegrationIssue[] {
  const issues: ConsumerIntegrationIssue[] = [];
  for (const field of [
    "scripts", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies"
  ] as const) {
    const value = manifest[field];
    if (value !== undefined &&
      (typeof value !== "object" || value === null || Array.isArray(value))) {
      issues.push(issue(`package.json#${field}`, "DOCS_CONSUMER_MANIFEST_FIELD_INVALID", `${field} must be one object when present.`));
    }
  }
  return issues;
}

function cohortDependencyIssues(
  dependencies: Record<string, unknown>,
  devDependencies: Record<string, unknown>,
  optionalDependencies: Record<string, unknown>,
  peerDependencies: Record<string, unknown>,
  targets: readonly CohortManifestTarget[]
): ConsumerIntegrationIssue[] {
  const issues: ConsumerIntegrationIssue[] = [];
  for (const { name: packageName } of targets) {
    for (const [field, declarations] of [
      ["dependencies", dependencies],
      ["optionalDependencies", optionalDependencies],
      ["peerDependencies", peerDependencies]
    ] as const) {
      if (declarations[packageName] !== undefined) {
        issues.push(issue(
          `package.json#${field}`,
          "DOCS_CONSUMER_NON_DEV_DEPENDENCY",
          `${packageName} may be declared only in root devDependencies.`
        ));
      }
    }
  }
  for (const { name: packageName, version } of targets) {
    if (devDependencies[packageName] !== version) {
      issues.push(issue(`package.json#devDependencies.${packageName}`, "DOCS_CONSUMER_COHORT_PIN_REQUIRED", `Update ${packageName} and pnpm-lock.yaml together to exact version ${version} before consumer apply.`));
    }
  }
  return issues;
}

function forbiddenRootDeclarationIssues(
  declarationsByField: readonly (readonly [string, Record<string, unknown>])[],
  packageNames: readonly string[]
): ConsumerIntegrationIssue[] {
  return packageNames.flatMap((packageName) => declarationsByField.flatMap(
    ([field, declarations]) => declarations[packageName] === undefined ? [] : [issue(
      `package.json#${field}.${packageName}`,
      "DOCS_CONSUMER_TRANSITIVE_ROOT_DECLARATION",
      `${packageName} is a transitive Cohort coordinate and must not be a root declaration.`
    )]
  ));
}

function targetsNpmAlias(value: unknown, packageNames: readonly string[]): boolean {
  return typeof value === "string" && packageNames.some((packageName) =>
    value === `npm:${packageName}` || value.startsWith(`npm:${packageName}@`)
  );
}

function cohortAliasIssues(
  declarationsByField: readonly (readonly [string, Record<string, unknown>])[],
  packageNames: readonly string[]
): ConsumerIntegrationIssue[] {
  return declarationsByField.flatMap(([field, declarations]) =>
    Object.entries(declarations).flatMap(([alias, value]) =>
      targetsNpmAlias(value, packageNames) ? [issue(
        `package.json#${field}.${alias}`,
        "DOCS_CONSUMER_COHORT_ALIAS_FORBIDDEN",
        `npm alias ${alias} must not target a Cohort package.`
      )] : []
    )
  );
}

function cohortManifestTargetsV1(
  cohort: QualifiedDocsCohortBindingV1
): readonly CohortManifestTarget[] {
  return Object.freeze([
    Object.freeze({ name: DOCS_PACKAGE, version: cohort.packages.docsProtocol.version }),
    Object.freeze({
      name: FOUNDATION_PACKAGE,
      version: cohort.packages.engineeringFoundation.version
    })
  ]);
}

export function projectPnpmManifestCohortTargets(input: {
  readonly bytes: Uint8Array;
  readonly targets: readonly CohortManifestTarget[];
  readonly transitivePackageNames?: readonly string[];
  readonly forbiddenAliasTargetPackageNames?: readonly string[];
}): Uint8Array {
  const { manifest, source } = parseManifest(input.bytes);
  const issues = manifestShapeIssues(manifest);
  const dependencies = recordField(manifest, "dependencies");
  const devDependencies = recordField(manifest, "devDependencies");
  const optionalDependencies = recordField(manifest, "optionalDependencies");
  const peerDependencies = recordField(manifest, "peerDependencies");
  const declarationsByField = [
    ["dependencies", dependencies],
    ["devDependencies", devDependencies],
    ["optionalDependencies", optionalDependencies],
    ["peerDependencies", peerDependencies]
  ] as const;
  for (const { name: packageName } of input.targets) {
    for (const [field, declarations] of [
      ["dependencies", dependencies],
      ["optionalDependencies", optionalDependencies],
      ["peerDependencies", peerDependencies]
    ] as const) {
      if (declarations[packageName] !== undefined) {
        issues.push(issue(
          `package.json#${field}`,
          "DOCS_CONSUMER_NON_DEV_DEPENDENCY",
          `${packageName} may be declared only in root devDependencies.`
        ));
      }
    }
  }
  issues.push(...cohortAliasIssues(
    declarationsByField,
    input.forbiddenAliasTargetPackageNames ?? []
  ));
  if (issues.length > 0) {
    throw new TypeError(issues.map(({ message }) => message).join(" "));
  }
  let postimage = source;
  for (const packageName of input.transitivePackageNames ?? []) {
    for (const [field, declarations] of declarationsByField) {
      if (declarations[packageName] !== undefined) {
        postimage = applyField(postimage, [field, packageName], void 0);
      }
    }
  }
  for (const { name: packageName, version } of input.targets) {
    postimage = applyField(postimage, ["devDependencies", packageName], version);
  }
  return Buffer.from(postimage, "utf8");
}

export function projectPnpmManifestCohortPinsV1(input: {
  readonly bytes: Uint8Array;
  readonly cohort: QualifiedDocsCohortBindingV1;
}): Uint8Array {
  return projectPnpmManifestCohortTargets({
    bytes: input.bytes,
    targets: cohortManifestTargetsV1(input.cohort)
  });
}

export function planPnpmManifestTargets(input: {
  readonly observation: ConsumerIntegrationFileObservation;
  readonly profilePath: string;
  readonly targets: readonly CohortManifestTarget[];
  readonly forbiddenRootPackageNames?: readonly string[];
  readonly forbiddenAliasTargetPackageNames?: readonly string[];
  readonly knownPriorScriptsDigest?: ConsumerIntegrationDigest;
}): PnpmManifestPlanV1 {
  if (input.observation.state === "absent") {
    const empty = digestBytes(new Uint8Array());
    return {
      state: "conflict",
      currentDigest: empty,
      expectedDigest: empty,
      issues: [issue("package.json", "DOCS_CONSUMER_MANIFEST_MISSING", "A root package.json is required and is never created by consumer integration.")]
    };
  }
  const bytes = Buffer.from(input.observation.bytes);
  const currentDigest = digestBytes(bytes);
  let source: string;
  let manifest: Record<string, unknown>;
  try {
    ({ manifest, source } = parseManifest(bytes));
  } catch (error) {
    return {
      state: "conflict",
      currentDigest,
      expectedDigest: currentDigest,
      issues: [issue("package.json", "DOCS_CONSUMER_MANIFEST_INVALID", error instanceof Error ? error.message : "package.json is invalid.")]
    };
  }
  const issues = manifestShapeIssues(manifest);
  const scripts = recordField(manifest, "scripts");
  const dependencies = recordField(manifest, "dependencies");
  const devDependencies = recordField(manifest, "devDependencies");
  const optionalDependencies = recordField(manifest, "optionalDependencies");
  const peerDependencies = recordField(manifest, "peerDependencies");
  const declarationsByField = [
    ["dependencies", dependencies],
    ["devDependencies", devDependencies],
    ["optionalDependencies", optionalDependencies],
    ["peerDependencies", peerDependencies]
  ] as const;
  issues.push(...cohortDependencyIssues(
    dependencies,
    devDependencies,
    optionalDependencies,
    peerDependencies,
    input.targets
  ));
  issues.push(...forbiddenRootDeclarationIssues(
    declarationsByField,
    input.forbiddenRootPackageNames ?? []
  ));
  issues.push(...cohortAliasIssues(
    declarationsByField,
    input.forbiddenAliasTargetPackageNames ?? []
  ));
  const desiredScripts = canonicalDocsScripts(input.profilePath);
  const observedScripts = Object.fromEntries(Object.keys(desiredScripts).map((script) => [
    script,
    scripts[script] ?? null
  ]));
  const observedScriptsDigest = digestBytes(Buffer.from(
    canonicalConsumerIntegrationJson(observedScripts),
    "utf8"
  ));
  let postimage = source;
  for (const [script, command] of Object.entries(desiredScripts)) {
    const pre = `pre${script}`;
    const post = `post${script}`;
    if (scripts[pre] !== undefined || scripts[post] !== undefined) {
      issues.push(issue(`package.json#scripts.${script}`, "DOCS_CONSUMER_RESERVED_LIFECYCLE_SCRIPT", `${pre} and ${post} are forbidden for managed documentation commands.`));
    }
    const current = scripts[script];
    if (current !== undefined && current !== command &&
      observedScriptsDigest !== input.knownPriorScriptsDigest) {
      issues.push(issue(`package.json#scripts.${script}`, "DOCS_CONSUMER_RESERVED_SCRIPT_CONFLICT", `${script} contains unknown local behavior and was not overwritten.`));
      continue;
    }
    if (current !== command) {
      postimage = applyField(postimage, ["scripts", script], command);
    }
  }
  const expectedBytes = Buffer.from(postimage, "utf8");
  const expectedDigest = digestBytes(expectedBytes);
  if (issues.length > 0) {
    return { state: "conflict", currentDigest, expectedDigest, issues: Object.freeze(issues) };
  }
  if (expectedDigest === currentDigest) {
    return { state: "exact-current", currentDigest, expectedDigest, issues: [] };
  }
  return {
    state: "known-prior",
    currentDigest,
    expectedDigest,
    postimage: expectedBytes,
    issues: []
  };
}

export function planPnpmManifestV1(input: {
  readonly observation: ConsumerIntegrationFileObservation;
  readonly profilePath: string;
  readonly cohort: QualifiedDocsCohortBindingV1;
  readonly knownPriorScriptsDigest?: ConsumerIntegrationDigest;
}): PnpmManifestPlanV1 {
  return planPnpmManifestTargets({
    observation: input.observation,
    profilePath: input.profilePath,
    targets: cohortManifestTargetsV1(input.cohort),
    ...(input.knownPriorScriptsDigest === undefined
      ? {}
      : { knownPriorScriptsDigest: input.knownPriorScriptsDigest })
  });
}
