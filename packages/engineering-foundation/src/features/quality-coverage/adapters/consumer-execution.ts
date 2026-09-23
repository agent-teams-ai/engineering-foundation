import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { parseSync, Visitor } from "oxc-parser";
import {
  assertNotCancelled,
  CapabilityInputError,
  qualitySourceTargets,
  type ManagedProcessExecutor, type QualityFileReader,
  type QualityObservationPorts, type QualityToolProvider, type ExplicitUnknownFinding
} from "../api.js";
import type { QualityConfigurationReader } from "./consumer-observations.js";
import { inspectConsumerToolchain } from "./consumer-toolchain.js";
import { createOxlintSession } from "./oxlint-session.js";
import { invalidQualityInput, mapQualityProfile, mapQualityTopology } from "./profile-input.js";

/** Bind one invocation to consumer-local tools and the module-owned compiler projects. */
export function createQualityToolProvider(input: {
  readonly ports: QualityObservationPorts;
  readonly configuration: QualityConfigurationReader;
  readonly readFile: QualityFileReader;
  readonly executor: ManagedProcessExecutor;
  readonly nodeExecutable: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): QualityToolProvider {
  return {
    async prepare(consumerRoot, configPath, sourcePaths, signal) {
      assertNotCancelled(signal);
      const value = await input.configuration.read(consumerRoot, configPath, "quality-profile", signal);
      await input.configuration.assertProfile(value);
      const profile = mapQualityProfile(value);
      const topology = mapQualityTopology(
        await input.configuration.read(consumerRoot, profile.featureProfilePath, "quality-topology", signal),
        profile.sourcePolicyPath
      );
      const authority = await input.ports.authority.source(consumerRoot, profile.sourcePolicyPath, signal);
      const inventory = await input.ports.inventory.read(consumerRoot, authority.workspaceManifestPath, signal);
      const rootPackage = inventory.packages.find(({ manifestPath }) => manifestPath === "package.json");
      if (rootPackage === undefined) { invalidQualityInput("The consumer root package is missing from workspace observations."); }
      const tools = await inspectConsumerToolchain({
        consumerRoot, dependencies: rootPackage.dependencies, read: input.readFile,
        ...(signal === undefined ? {} : { signal })
      });
      assertNotCancelled(signal);
      const sourceTargets = qualitySourceTargets(sourcePaths, topology, authority);
      assertNotCancelled(signal);
      const session = createOxlintSession({
        consumerRoot, ...tools, nodeExecutable: input.nodeExecutable,
        environment: { ...input.environment, OXLINT_TSGOLINT_PATH: tools.typedEntrypoint },
        configPath: profile.lintConfigPath,
        sourceRoots: sourceTargets,
        projects: profile.compilerProjects
      }, input.executor);
      return {
        ...session,
        async explicitUnknown(scanSignal) {
          try {
            const admissionValue = profile.bridgeAdmissionsPath === undefined ? undefined :
              await input.configuration.read(consumerRoot, profile.bridgeAdmissionsPath, "quality-bridge-admissions", scanSignal);
            return await inspectExplicitUnknown({ consumerRoot, paths: sourceTargets, admissionValue, read: input.readFile,
              ...(scanSignal === undefined ? {} : { signal: scanSignal }) });
          } catch (error) {
            if (scanSignal?.aborted === true || error instanceof CapabilityInputError) { throw error; }
            invalidQualityInput(error instanceof Error ? error.message : "Explicit unknown scan failed.");
          }
        }
      };
    }
  };
}

type Finding = ExplicitUnknownFinding;

interface Admission extends Finding {
  readonly rationale: string;
  readonly rejectingTest: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const digest = (source: string): string => createHash("sha256").update(source).digest("hex");
const key = ({ path, start, end, sha256 }: Finding): string => `${path}:${start}:${end}:${sha256}`;
const pathPattern = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))[\w@./-]+$/u;

function unwrap(node: { readonly type: string; readonly expression?: unknown }): unknown {
  let current: unknown = node;
  while (current !== null && typeof current === "object" &&
    ["ParenthesizedExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSInstantiationExpression"].includes((current as { type: string }).type)) {
    current = (current as { expression: unknown }).expression;
  }
  return current;
}

function typeName(node: unknown): string | undefined {
  let current: unknown = node;
  while (current !== null && typeof current === "object" &&
    "type" in current && current.type === "TSParenthesizedType") {
    current = "typeAnnotation" in current ? current.typeAnnotation : undefined;
  }
  return current !== null && typeof current === "object" && "type" in current &&
    typeof current.type === "string" ? current.type : undefined;
}

function findChains(path: string, source: string): readonly Finding[] {
  const parsed = parseSync(path, source, { astType: "ts" });
  if (parsed.errors.length > 0) { throw new Error(`Explicit unknown scan could not parse ${path}.`); }
  const findings: Finding[] = [];
  // OXC's JS binding reports UTF-16 offsets, including after and inside astral text.
  const visit = (node: { readonly type: string; readonly expression: unknown; readonly typeAnnotation?: unknown; readonly start: number; readonly end: number }) => {
    const inner = unwrap(node.expression as { type: string; expression?: unknown });
    if (inner !== null && typeof inner === "object" &&
      ["TSAsExpression", "TSTypeAssertion"].includes((inner as { type: string }).type) &&
      typeName((inner as { typeAnnotation?: unknown }).typeAnnotation) === "TSUnknownKeyword" &&
      typeName(node.typeAnnotation) !== "TSUnknownKeyword") {
      const start = node.start;
      const end = node.end;
      findings.push({ path, start, end, sha256: digest(source.slice(start, end)) });
    }
  };
  new Visitor({ TSAsExpression: visit, TSTypeAssertion: visit }).visit(parsed.program);
  return findings.toSorted((a, b) => a.start - b.start || a.end - b.end);
}

function admissions(value: unknown): readonly Admission[] {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "bridges,schemaVersion") { throw new Error("Invalid explicit unknown admission document."); }
  const document = value as { schemaVersion?: unknown; bridges?: unknown };
  if (document.schemaVersion !== 1 || !Array.isArray(document.bridges) || document.bridges.length > 500) {
    throw new Error("Invalid explicit unknown admission document.");
  }
  return document.bridges.map(parseAdmission);
}

function boundedPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 240 && pathPattern.test(value);
}

function parseAdmission(entry: unknown): Admission {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
    Object.keys(entry).toSorted().join(",") !== "end,path,rationale,rejectingTest,sha256,start") {
    throw new Error("Invalid explicit unknown admission record.");
  }
  const item = entry as Partial<Admission>;
  if (!boundedPath(item.path) || !boundedPath(item.rejectingTest) ||
    !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) ||
    (item.start ?? -1) < 0 || (item.end ?? 0) <= (item.start ?? 0) ||
    typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256) ||
    typeof item.rationale !== "string" || item.rationale.trim().length < 12 || item.rationale.length > 400) {
    throw new Error("Invalid explicit unknown admission record.");
  }
  return item as Admission;
}

/** OXC objects end here. Only normalized findings enter application policy. */
export async function inspectExplicitUnknown(input: {
  readonly consumerRoot: string;
  readonly paths: readonly string[];
  readonly admissionValue?: unknown;
  readonly read: QualityFileReader;
  readonly signal?: AbortSignal;
}): Promise<readonly Finding[]> {
  const records = input.admissionValue === undefined ? [] : admissions(input.admissionValue);
  const recordKeys = new Set<string>();
  for (const record of records) {
    const identity = key(record);
    if (recordKeys.has(identity)) { throw new Error(`Duplicate explicit unknown admission: ${record.path}.`); }
    recordKeys.add(identity);
    // Containment and existence are checked; this does not prove the test ran or rejects the bridge.
    await input.read({ root: input.consumerRoot, candidate: resolve(input.consumerRoot, record.rejectingTest), maxBytes: 2 * 1024 * 1024 });
  }
  const matched = new Set<string>();
  const unadmitted: Finding[] = [];
  for (const path of input.paths.toSorted()) {
    if (input.signal?.aborted === true) { throw input.signal.reason; }
    if (!/\.(?:ts|tsx|mts|cts)$/u.test(path)) { continue; }
    const bytes = await input.read({ root: input.consumerRoot, candidate: resolve(input.consumerRoot, path), maxBytes: 2 * 1024 * 1024 });
    const source = decoder.decode(bytes);
    for (const finding of findChains(path, source)) {
      const identity = key(finding);
      if (recordKeys.has(identity)) { matched.add(identity); continue; }
      unadmitted.push(finding);
    }
  }
  for (const record of records) {
    if (!matched.has(key(record))) { throw new Error(`Stale or unmatched explicit unknown admission: ${record.path}:${record.start}.`); }
  }
  return unadmitted;
}
