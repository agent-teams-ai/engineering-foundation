import { applyEdits, modify } from "jsonc-parser";

import { parseJsonRecord, recordField } from "../../adapters/adoption-input.js";
import type {
  ConsumerIntegrationDigest,
  ConsumerIntegrationFileObservation,
  ConsumerIntegrationIssue,
  QualifiedDocsCohortBindingV1
} from "../domain/model.js";
import {
  canonicalConsumerIntegrationJson,
  canonicalDocsScripts,
  digestBytes
} from "../application/policies/consumer-integration-assets.js";

const DOCS_PACKAGE = "@agent-teams/docs-protocol";
const FOUNDATION_PACKAGE = "@agent-teams/engineering-foundation";

/** @public */
export interface PnpmManifestPlanV1 {
  readonly state: "conflict" | "exact-current" | "known-prior";
  readonly currentDigest: ConsumerIntegrationDigest;
  readonly expectedDigest: ConsumerIntegrationDigest;
  readonly postimage?: Uint8Array;
  readonly issues: readonly ConsumerIntegrationIssue[];
}

function issue(subject: string, code: string, message: string): ConsumerIntegrationIssue {
  return { code, severity: "error", subject, message };
}

function rejectPrototypeKeys(value: unknown, path = "package.json"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectPrototypeKeys(entry, `${path}[${index}]`));
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
  cohort: QualifiedDocsCohortBindingV1
): ConsumerIntegrationIssue[] {
  const issues: ConsumerIntegrationIssue[] = [];
  for (const packageName of [DOCS_PACKAGE, FOUNDATION_PACKAGE]) {
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
  const requiredVersions = {
    [DOCS_PACKAGE]: cohort.packages.docsProtocol.version,
    [FOUNDATION_PACKAGE]: cohort.packages.engineeringFoundation.version
  } as const;
  for (const [packageName, version] of Object.entries(requiredVersions)) {
    if (devDependencies[packageName] !== version) {
      issues.push(issue(`package.json#devDependencies.${packageName}`, "DOCS_CONSUMER_COHORT_PIN_REQUIRED", `Update ${packageName} and pnpm-lock.yaml together to exact version ${version} before consumer apply.`));
    }
  }
  return issues;
}

export function planPnpmManifestV1(input: {
  readonly observation: ConsumerIntegrationFileObservation;
  readonly profilePath: string;
  readonly cohort: QualifiedDocsCohortBindingV1;
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
  issues.push(...cohortDependencyIssues(
    dependencies,
    devDependencies,
    optionalDependencies,
    peerDependencies,
    input.cohort
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
