import { Ajv2020 } from "ajv/dist/2020.js";

type JsonRecord = Record<string, unknown>;

type QualificationRuntime = Readonly<{
  nodeVersion: string;
  pnpmVersion: string;
  platform: string;
  architecture: string;
}>;

type RuntimeLane = Readonly<{
  node: string;
  qualificationRuntime: QualificationRuntime;
  default: boolean;
}>;

type NormalizedRuntimePolicy = Readonly<{
  policyId: string;
  policyVersion: string;
  sourceDigest: string;
  pnpm: string;
  lanes: Readonly<Record<"node-24-production-default" | "node-26-managed-qualified", RuntimeLane>>;
}>;

type ExpectedRuntimePolicy = Readonly<{
  selectedLane: string;
  node: string;
  pnpm: string;
  qualificationRuntime: QualificationRuntime;
}>;

type RuntimePolicyNormalization = Readonly<{
  expected: ExpectedRuntimePolicy;
  schema: JsonRecord;
  sourceDigest: string;
}>;

function fail(message: string): never {
  throw new Error(`Public managed registry canary policy rejected: ${message}`);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value: unknown, keys: readonly string[], label: string): JsonRecord {
  const object = record(value, label);
  if (Object.keys(object).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    fail(`${label} has unexpected keys`);
  }
  return object;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail(`${label} must be a string`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value).toSorted(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedShape(value: unknown, validateSchema: (value: unknown) => void): JsonRecord {
  const raw = isRecord(value) && value.managedRuntime === undefined ? undefined : value;
  if (raw !== undefined) {
    validateSchema(raw);
  }
  const source = record(raw === undefined ? value : raw, "packed runtime policy");
  const managedRuntime = raw === undefined
    ? source
    : record(source.managedRuntime, "packed runtime policy managedRuntime");
  const normalized = raw === undefined ? source : {
    policyId: source.policyId,
    policyVersion: source.policyVersion,
    sourceDigest: source.sourceDigest,
    pnpm: managedRuntime.pnpm,
    lanes: managedRuntime.lanes,
  };
  return exactKeys(
    normalized,
    ["policyId", "policyVersion", "sourceDigest", "pnpm", "lanes"],
    "packed runtime policy",
  );
}

function normalizeLane(value: unknown, laneId: string, expectedDefault: boolean): RuntimeLane {
  const lane = exactKeys(value, ["node", "qualificationRuntime", "default"], `packed runtime policy lane ${laneId}`);
  const qualificationRuntime = exactKeys(
    lane.qualificationRuntime,
    ["nodeVersion", "pnpmVersion", "platform", "architecture"],
    `packed runtime policy qualification runtime ${laneId}`,
  );
  const defaultLane = lane.default;
  if (typeof defaultLane !== "boolean" || defaultLane !== expectedDefault) {
    fail(`packed runtime policy lane ${laneId} has the wrong default`);
  }
  return Object.freeze({
    node: string(lane.node, `packed runtime policy lane ${laneId} node`),
    qualificationRuntime: Object.freeze({
      nodeVersion: string(qualificationRuntime.nodeVersion, `packed runtime policy qualification runtime ${laneId} nodeVersion`),
      pnpmVersion: string(qualificationRuntime.pnpmVersion, `packed runtime policy qualification runtime ${laneId} pnpmVersion`),
      platform: string(qualificationRuntime.platform, `packed runtime policy qualification runtime ${laneId} platform`),
      architecture: string(qualificationRuntime.architecture, `packed runtime policy qualification runtime ${laneId} architecture`),
    }),
    default: defaultLane,
  });
}

function normalizeLanes(value: unknown): NormalizedRuntimePolicy["lanes"] {
  const lanes = exactKeys(
    value,
    ["node-24-production-default", "node-26-managed-qualified"],
    "packed runtime policy lanes",
  );
  const production = normalizeLane(lanes["node-24-production-default"], "node-24-production-default", false);
  const qualified = normalizeLane(lanes["node-26-managed-qualified"], "node-26-managed-qualified", true);
  return Object.freeze({
    "node-24-production-default": production,
    "node-26-managed-qualified": qualified,
  });
}

function validateCandidate(value: unknown, expected: ExpectedRuntimePolicy): void {
  if (!isRecord(value)) {
    return;
  }
  const managedCandidate = record(value.managedCandidate, "packed runtime policy managedCandidate");
  const managedRuntime = record(value.managedRuntime, "packed runtime policy managedRuntime");
  if (value.schemaVersion !== 1 ||
      managedCandidate.selected !== false ||
      managedCandidate.status !== "candidate-unqualified" ||
      managedCandidate.cohortSchema !== 3 ||
      managedCandidate.consumerIntegrationProfile !== 4 ||
      managedCandidate.managedState !== 3 ||
      managedCandidate.qualificationReceipt !== 1 ||
      managedCandidate.runtimeLane !== expected.selectedLane ||
      managedRuntime.status !== "candidate-unqualified") {
    fail("packed runtime policy candidate is selected or incomplete");
  }
}

export function normalizePackedRuntimePolicy(
  value: unknown,
  normalization: RuntimePolicyNormalization,
): NormalizedRuntimePolicy {
  const raw = isRecord(value) && value.managedRuntime === undefined ? undefined : value;
  const shape = normalizedShape(value, (candidate) => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(normalization.schema);
    if (!validate(candidate)) {
      fail(`packed runtime policy schema validation failed: ${JSON.stringify(validate.errors)}`);
    }
  });
  const policyId = string(shape.policyId, "packed runtime policy policyId");
  const policyVersion = string(shape.policyVersion, "packed runtime policy policyVersion");
  const sourceDigest = string(shape.sourceDigest, "packed runtime policy sourceDigest");
  const pnpm = string(shape.pnpm, "packed runtime policy pnpm");
  const lanes = normalizeLanes(shape.lanes);
  if (policyId !== "agent-teams.docs-protocol-current-policy" ||
      policyVersion !== "3.0.0" ||
      sourceDigest !== normalization.sourceDigest ||
      pnpm !== normalization.expected.pnpm) {
    fail("packed runtime policy identity is invalid");
  }
  const qualified = lanes["node-26-managed-qualified"];
  if (qualified.node !== normalization.expected.node ||
      canonicalJson(qualified.qualificationRuntime) !== canonicalJson(normalization.expected.qualificationRuntime)) {
    fail("packed runtime policy qualified lane is invalid");
  }
  if (raw !== undefined) {
    validateCandidate(raw, normalization.expected);
  }
  return Object.freeze({
    policyId,
    policyVersion,
    sourceDigest,
    pnpm,
    lanes: Object.freeze(structuredClone(lanes)),
  });
}
