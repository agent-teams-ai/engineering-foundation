import { createHash } from "node:crypto";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";

import type {
  Authority,
  CohortV2Authority,
  CohortV3Authority,
  JsonRecord,
  LockfileEvidence,
  ManagedQualificationRequest,
  ManagedState,
  PackageEvidence,
  QualificationHostPorts,
  QualificationProfileV2,
  QualificationProfileV3,
  Repository,
  RuntimeObservation,
  SchemaCase,
} from "./public-managed-registry-canary-qualification-types.mts";
import { assertCohortV3Consistency } from "./public-managed-registry-canary-runtime-policy.mts";

const adapterSegments: readonly string[] = ["node_modules", "@agent-teams", "docs-protocol-agent-teams"];
const commandTimeout = 240_000;

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function managedState(value: unknown, label: string): ManagedState {
  const state = record(value, label);
  if (!isManagedState(state)) {
    throw new Error(`${label} has an invalid managed-state identity.`);
  }
  return state;
}

function isManagedState(value: unknown): value is ManagedState {
  return isRecord(value) &&
    typeof value.schemaVersion === "number" &&
    typeof value.stateDigest === "string";
}

function withoutStateDigest(value: JsonRecord): JsonRecord {
  const { stateDigest: _stateDigest, ...body } = value;
  return body;
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

function qualificationProfile(cohort: CohortV2Authority, repository: Repository): QualificationProfileV2 {
  return Object.freeze({
    schemaVersion: 3,
    repository,
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    qualification: {
      contractPath: "architecture/foundation/docs-protocol-qualification.json",
      gateCommand: "pnpm docs:protocol:check",
    },
    cohort,
  });
}

function qualificationProfileCohortV3(cohort: CohortV3Authority, repository: Repository): QualificationProfileV3 {
  return Object.freeze({
    schemaVersion: 4,
    repository,
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    qualification: {
      contractPath: "architecture/foundation/docs-protocol-qualification.json",
      gateCommand: "pnpm docs:protocol:check",
    },
    cohort,
  });
}

export function assertQualificationReceiptDigest(receipt: unknown): void {
  const value = record(receipt, "Qualification receipt");
  if (value.schemaVersion === 1) {
    assertCohortV3QualificationReceiptDigest(value);
    return;
  }
  const { receiptDigest, ...body } = value;
  if (receiptDigest !== sha256(Buffer.from(canonicalJson(body), "utf8"))) {
    throw new Error("Qualification v3 receipt digest is not independently canonical.");
  }
}

export function assertCohortV3QualificationReceiptDigest(receipt: unknown): void {
  const value = record(receipt, "Qualification Cohort v3 receipt");
  if (value.namespace !== "docs-protocol-cohort-v3-qualification-receipt/v1") {
    throw new Error("Qualification Cohort v3 receipt namespace is invalid.");
  }
  const { receiptDigest, ...body } = value;
  if (receiptDigest !== sha256(Buffer.from(canonicalJson(body), "utf8"))) {
    throw new Error("Qualification Cohort v3 receipt digest is not independently canonical.");
  }
}

export function assertCanonicalManagedState(serialization: string): ManagedState {
  if (typeof serialization !== "string" || !serialization.endsWith("\n")) {
    throw new Error("Managed-state v2 serialization is not newline terminated.");
  }
  const state = managedState(JSON.parse(serialization), "Managed state");
  if (serialization !== `${canonicalJson(state)}\n`) {
    throw new Error("Managed-state v2 serialization is not canonical JSON.");
  }
  const body = withoutStateDigest(state);
  if (state.schemaVersion === 3) {
    const expectedV3 = sha256(Buffer.from(canonicalJson({
      domain: "agent-teams.docs-protocol.managed-state/v3",
      body,
    }), "utf8"));
    if (state.stateDigest !== expectedV3) {
      throw new Error("Managed-state v3 stateDigest is invalid.");
    }
    return state;
  }
  const expected = sha256(Buffer.from(canonicalJson({
    domain: "agent-teams.docs-protocol.managed-state/v2",
    body,
  }), "utf8"));
  if (state.stateDigest !== expected) {
    throw new Error("Managed-state v2 stateDigest is invalid.");
  }
  return state;
}

async function validateManagedQualification(
  root: string,
  qualificationReceipt: JsonRecord,
  managedStateSerialization: string,
  profile: QualificationProfileV2,
  ports: QualificationHostPorts,
): Promise<ManagedState> {
  assertQualificationReceiptDigest(qualificationReceipt);
  const managedStateValue = assertCanonicalManagedState(managedStateSerialization);
  const schemaRoot = join(root, ...adapterSegments, "schemas");
  const qualificationSchema = await ports.readSchema(join(schemaRoot, "docs-protocol-qualification-receipt", "v3.schema.json"));
  const cohortSchema = await ports.readSchema(join(schemaRoot, "qualified-docs-cohort", "v2.schema.json"));
  const profileSchema = await ports.readSchema(join(schemaRoot, "docs-consumer-integration-profile", "v3.schema.json"));
  const managedSchema = await ports.readSchema(join(schemaRoot, "docs-consumer-managed-state", "v2.schema.json"));
  const docsProtocolSchema = await ports.readSchema(join(schemaRoot, "docs-protocol-profile", "v1.schema.json"));
  if (profileSchema.$id !== "https://agent-teams.ai/schemas/docs-consumer-integration-profile/v3" ||
      managedSchema.$id !== "https://agent-teams.ai/schemas/docs-consumer-managed-state/v2" ||
      docsProtocolSchema.$id !== "https://agent-teams.ai/schemas/docs-protocol-profile/v1") {
    throw new Error("Installed schema tuple identity is not exactly 3/2/1.");
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(cohortSchema);
  const schemaCases: readonly SchemaCase[] = [
    ["consumer integration profile v3", profileSchema, profile],
    ["qualification receipt v3", qualificationSchema, qualificationReceipt],
    ["managed state v2", managedSchema, managedStateValue],
  ];
  for (const [label, schema, value] of schemaCases) {
    const validate = ajv.compile(schema);
    if (!validate(value)) {
      throw new Error(`Installed ${label} schema validation failed: ${JSON.stringify(validate.errors)}`);
    }
  }
  ajv.compile(docsProtocolSchema);
  return managedStateValue;
}

async function validateManagedQualificationCohortV3(
  root: string,
  qualificationReceipt: JsonRecord,
  managedStateSerialization: string,
  profile: QualificationProfileV3,
  ports: QualificationHostPorts,
): Promise<ManagedState> {
  if (profile.schemaVersion !== 4 || profile.cohort.schemaVersion !== 3 ||
      qualificationReceipt.schemaVersion !== 1 ||
      qualificationReceipt.namespace !== "docs-protocol-cohort-v3-qualification-receipt/v1" ||
      qualificationReceipt.profileSchemaVersion !== 4 ||
      record(qualificationReceipt.cohort, "Qualification Cohort v3 receipt cohort").schemaVersion !== 3) {
    throw new Error("Managed qualification contains mixed Cohort/profile/receipt generations.");
  }
  assertCohortV3QualificationReceiptDigest(qualificationReceipt);
  const managedStateValue = assertCanonicalManagedState(managedStateSerialization);
  if (managedStateValue.schemaVersion !== 3) {
    throw new Error("Managed qualification contains mixed managed-state generations.");
  }
  const schemaRoot = join(root, ...adapterSegments, "schemas");
  const qualificationSchema = await ports.readSchema(
    join(schemaRoot, "docs-protocol-cohort-v3-qualification-receipt", "v1.schema.json"),
  );
  const cohortSchema = await ports.readSchema(join(schemaRoot, "qualified-docs-cohort", "v3.schema.json"));
  const profileSchema = await ports.readSchema(join(schemaRoot, "docs-consumer-integration-profile", "v4.schema.json"));
  const managedSchema = await ports.readSchema(join(schemaRoot, "docs-consumer-managed-state", "v3.schema.json"));
  const docsProtocolSchema = await ports.readSchema(join(schemaRoot, "docs-protocol-profile", "v1.schema.json"));
  if (qualificationSchema.$id !== "https://agent-teams.ai/schemas/docs-protocol-cohort-v3-qualification-receipt/v1" ||
      cohortSchema.$id !== "https://agent-teams.ai/schemas/qualified-docs-cohort/v3" ||
      profileSchema.$id !== "https://agent-teams.ai/schemas/docs-consumer-integration-profile/v4" ||
      managedSchema.$id !== "https://agent-teams.ai/schemas/docs-consumer-managed-state/v3" ||
      docsProtocolSchema.$id !== "https://agent-teams.ai/schemas/docs-protocol-profile/v1") {
    throw new Error("Installed schema tuple identity is not exactly 4/3/1/qualificationReceipt1.");
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(cohortSchema);
  const schemaCases: readonly SchemaCase[] = [
    ["consumer integration profile v4", profileSchema, profile],
    ["qualification Cohort v3 receipt v1", qualificationSchema, qualificationReceipt],
    ["managed state v3", managedSchema, managedStateValue],
  ];
  for (const [label, schema, value] of schemaCases) {
    const validate = ajv.compile(schema);
    if (!validate(value)) {
      throw new Error(`Installed ${label} schema validation failed: ${JSON.stringify(validate.errors)}`);
    }
  }
  ajv.compile(docsProtocolSchema);
  return managedStateValue;
}

function lockfileCapture(
  lockfileEvidence: LockfileEvidence,
): readonly string[] {
  const capturedLockfile = lockfileEvidence.lockfileBytes.toString("base64");
  return [
    `const capturedLockfileBytes = Buffer.from(${JSON.stringify(capturedLockfile)}, 'base64');`,
    `const expectedLockfileDigest = ${JSON.stringify(lockfileEvidence.receipt.lockfileDigest)};`,
    "if (`sha256:${createHash('sha256').update(capturedLockfileBytes).digest('hex')}` !== expectedLockfileDigest) throw new Error('Embedded lockfile capture digest mismatch.');",
    "const exactLockfileBytes = () => Buffer.from(capturedLockfileBytes);",
  ];
}

function qualificationProgramV2(
  authorityProfile: QualificationProfileV2,
  lockfileEvidence: LockfileEvidence,
  observedPackages: PackageEvidence,
): string {
  return [
    "import { createHash } from 'node:crypto';",
    `const authorityProfile = ${JSON.stringify(authorityProfile)};`,
    ...lockfileCapture(lockfileEvidence),
    "const { canonicalDocsScriptsDigest, canonicalManagedRoute, canonicalManagedState, describeCanonicalConsumerAssets } = await import('@agent-teams/docs-protocol-agent-teams');",
    "const { observeDocsProtocolQualificationV3Lockfile, runDocsProtocolQualificationV3 } = await import('@agent-teams/docs-protocol-agent-teams/qualification');",
    "const observed = observeDocsProtocolQualificationV3Lockfile({ profile: authorityProfile, lockfileBytes: exactLockfileBytes() });",
    "if (observed.runtimeClosureDigest !== authorityProfile.cohort.runtime.runtimeClosureDigest) throw new Error('Observed runtime closure differs from Cohort authority.');",
    "const trustedCohort = { ...authorityProfile.cohort, runtime: { ...authorityProfile.cohort.runtime, runtimeClosureDigest: observed.runtimeClosureDigest } };",
    "const profile = { ...authorityProfile, cohort: trustedCohort };",
    `const evidence = { packages: ${JSON.stringify(observedPackages)}, schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 }, runtimeClosureDigest: observed.runtimeClosureDigest };`,
    "const receipt = runDocsProtocolQualificationV3({ profile, evidence, lockfileBytes: exactLockfileBytes() });",
    "const canonical = describeCanonicalConsumerAssets(profile.cohort);",
    "const routeDigest = `sha256:${createHash('sha256').update(canonicalManagedRoute(profile.skillPath)).digest('hex')}`;",
    "const assets = { ...canonical, agentsRouteDigest: routeDigest, docsScriptsDigest: canonicalDocsScriptsDigest(profile.profilePath) };",
    "const managedState = canonicalManagedState(profile, assets);",
    "process.stdout.write(JSON.stringify({ managedState, observed, receipt }));",
  ].join("\n");
}

function qualificationProgramV3(
  authorityProfile: QualificationProfileV3,
  lockfileEvidence: LockfileEvidence,
  evidence: JsonRecord,
  expectedRuntime: CohortV3Authority["runtime"],
  runtimeObservation: RuntimeObservation,
): string {
  return [
    "import { createHash } from 'node:crypto';",
    `const authorityProfile = ${JSON.stringify(authorityProfile)};`,
    ...lockfileCapture(lockfileEvidence),
    "const { canonicalDocsScriptsDigest, canonicalManagedRoute, canonicalManagedState, describeCanonicalConsumerAssets } = await import('@agent-teams/docs-protocol-agent-teams');",
    "const { observeDocsProtocolQualificationV3Lockfile, runDocsProtocolQualificationV3 } = await import('@agent-teams/docs-protocol-agent-teams/qualification');",
    `const expectedHostRuntime = ${JSON.stringify(runtimeObservation)};`,
    "const observed = observeDocsProtocolQualificationV3Lockfile({ profile: authorityProfile, lockfileBytes: exactLockfileBytes() });",
    `if (observed.runtimeClosureDigest !== ${JSON.stringify(expectedRuntime.runtimeClosure.digest)}) throw new Error('Observed runtime closure differs from Cohort authority.');`,
    `const evidence = ${JSON.stringify(evidence)};`,
    "const receipt = runDocsProtocolQualificationV3({ profile: authorityProfile, evidence, lockfileBytes: exactLockfileBytes() });",
    "const observedRuntime = receipt.runtime.qualificationRuntime;",
    "if (JSON.stringify(observedRuntime) !== JSON.stringify(expectedHostRuntime)) throw new Error('Qualification receipt differs from the pre-install runtime observation.');",
    "const canonical = describeCanonicalConsumerAssets(authorityProfile.cohort);",
    "const routeDigest = `sha256:${createHash('sha256').update(canonicalManagedRoute(authorityProfile.skillPath)).digest('hex')}`;",
    "const assets = { ...canonical, agentsRouteDigest: routeDigest, docsScriptsDigest: canonicalDocsScriptsDigest(authorityProfile.profilePath) };",
    "const managedState = canonicalManagedState(authorityProfile, assets);",
    "process.stdout.write(JSON.stringify({ managedState, observed, observedRuntime, receipt }));",
  ].join("\n");
}

export async function managedQualificationCohortV2(
  root: string,
  authority: Authority,
  repository: Repository,
  { observedPackages, lockfileEvidence }: ManagedQualificationRequest,
  ports: QualificationHostPorts,
): Promise<JsonRecord> {
  if (sha256(lockfileEvidence.lockfileBytes) !== lockfileEvidence.receipt.lockfileDigest) {
    throw new Error("Captured pnpm lockfile bytes differ from install receipt digest.");
  }
  const cohort = authority.cohort.schemaVersion === 2 ? authority.cohort : undefined;
  if (cohort === undefined) {
    throw new Error("Managed qualification requires Cohort v2.");
  }
  const authorityProfile = qualificationProfile(cohort, repository);
  const program = qualificationProgramV2(authorityProfile, lockfileEvidence, observedPackages);
  const result = await ports.run(process.execPath, ["--input-type=module", "--eval", program], root, { timeoutMs: commandTimeout });
  const output = record(ports.parseJson(result.stdout), "Managed qualification output");
  const observed = record(output.observed, "Managed qualification observed evidence");
  const receipt = record(output.receipt, "Managed qualification receipt");
  const managedStateValue = await validateManagedQualification(
    root,
    receipt,
    text(output.managedState, "Managed qualification managed state"),
    authorityProfile,
    ports,
  );
  if (observed.runtimeClosureDigest !== record(receipt.runtime, "Managed qualification receipt runtime").runtimeClosureDigest ||
      managedStateValue.schemaVersion !== 2) {
    throw new Error("Managed qualification evidence is internally inconsistent.");
  }
  return Object.freeze({
    actualRuntimeClosureDigest: observed.runtimeClosureDigest,
    managedState: Object.freeze({
      schemaVersion: 2,
      schemaValidated: true,
      serialization: output.managedState,
      stateDigest: managedStateValue.stateDigest,
    }),
    qualificationReceipt: Object.freeze(receipt),
    schemaEvidence: Object.freeze({
      consumerIntegration: 3,
      docsProtocol: 1,
      managedState: 2,
      validated: true,
    }),
  });
}

export async function managedQualificationCohortV3(
  root: string,
  authority: Authority,
  repository: Repository,
  { observedPackages, lockfileEvidence }: ManagedQualificationRequest,
  ports: QualificationHostPorts,
): Promise<JsonRecord> {
  const observedRuntime = lockfileEvidence.runtimeObservation;
  if (observedRuntime === undefined ||
      observedRuntime.nodeVersion !== "26.11.1" ||
      observedRuntime.pnpmVersion !== "11.20.0" ||
      observedRuntime.platform !== "linux" ||
      observedRuntime.architecture !== "x64") {
    throw new Error("Pre-install runtime observation is not the exact qualified tuple.");
  }
  if (sha256(lockfileEvidence.lockfileBytes) !== lockfileEvidence.receipt.lockfileDigest) {
    throw new Error("Captured pnpm lockfile bytes differ from install receipt digest.");
  }
  const cohort = authority.cohort.schemaVersion === 3 ? authority.cohort : undefined;
  if (cohort === undefined) {
    throw new Error("Managed qualification requires Cohort v3.");
  }
  const expectedPackages = Object.fromEntries(authority.coordinates.map(({ key, version, integrity }) => [key, {
    version,
    integrity,
  }]));
  if (Object.keys(observedPackages).length !== 5 ||
      canonicalJson(observedPackages) !== canonicalJson(expectedPackages)) {
    throw new Error("Host package/SRI observations differ from exact Cohort authority.");
  }
  const expectedRuntime = cohort.runtime;
  if (expectedRuntime.policy.id !== "agent-teams.docs-protocol-current-policy" ||
      expectedRuntime.policy.version !== "3.0.0" ||
      expectedRuntime.selectedLane !== "node-26-managed-qualified" ||
      expectedRuntime.node !== ">=26.0.0 <27" ||
      expectedRuntime.pnpm !== ">=11.17.0 <12" ||
      canonicalJson(expectedRuntime.qualificationRuntime) !== canonicalJson({
        nodeVersion: "26.11.1",
        pnpmVersion: "11.20.0",
        platform: "linux",
        architecture: "x64",
      }) ||
      expectedRuntime.runtimeClosure.domain !== "agent-teams.docs-runtime-closure/v2") {
    throw new Error("Cohort v3 policy/runtime authority is not the exact qualified Node 26 tuple.");
  }
  const runtimeObservation: RuntimeObservation = Object.freeze({
    nodeVersion: observedRuntime.nodeVersion,
    pnpmVersion: observedRuntime.pnpmVersion,
    platform: observedRuntime.platform,
    architecture: observedRuntime.architecture,
  });
  const authorityProfile = qualificationProfileCohortV3(cohort, repository);
  const evidence = Object.freeze({
    cohort: Object.freeze({
      cohortId: cohort.cohortId,
      recordDigest: cohort.recordDigest,
      qualificationEventDigest: cohort.qualificationEventDigest,
      candidateDigest: cohort.candidateDigest,
    }),
    packages: Object.freeze(structuredClone(expectedPackages)),
    schemas: Object.freeze({
      consumerIntegration: 4,
      managedState: 3,
      qualificationReceipt: 1,
      docsProtocol: 1,
    }),
    policy: Object.freeze({
      id: expectedRuntime.policy.id,
      version: expectedRuntime.policy.version,
      sourceDigest: expectedRuntime.policy.digest,
    }),
    runtime: Object.freeze({
      selectedLane: expectedRuntime.selectedLane,
      node: expectedRuntime.node,
      pnpm: expectedRuntime.pnpm,
      qualificationRuntime: Object.freeze({ ...runtimeObservation }),
      runtimeClosureDigest: expectedRuntime.runtimeClosure.digest,
    }),
  });
  const program = qualificationProgramV3(
    authorityProfile,
    lockfileEvidence,
    evidence,
    expectedRuntime,
    runtimeObservation,
  );
  const result = await ports.run(process.execPath, ["--input-type=module", "--eval", program], root, { timeoutMs: commandTimeout });
  const output = record(ports.parseJson(result.stdout), "Managed Cohort v3 qualification output");
  const receipt = record(output.receipt, "Managed Cohort v3 receipt");
  const managedStateValue = await validateManagedQualificationCohortV3(
    root,
    receipt,
    text(output.managedState, "Managed Cohort v3 managed state"),
    authorityProfile,
    ports,
  );
  assertCohortV3Consistency({
    output: { ...output, receipt },
    cohort,
    evidence,
    expectedPackages: Object.freeze(authority.coordinates.map(({ key, name, version, integrity }) => ({
      key,
      name,
      version,
      integrity,
    }))),
    managedStateValue,
    runtimeObservation,
  });
  return Object.freeze({
    actualRuntimeClosureDigest: record(output.observed, "Managed Cohort v3 observed evidence").runtimeClosureDigest,
    runtimeObservation: Object.freeze({ ...runtimeObservation }),
    managedState: Object.freeze({
      schemaVersion: 3,
      schemaValidated: true,
      serialization: output.managedState,
      stateDigest: managedStateValue.stateDigest,
    }),
    qualificationReceipt: Object.freeze(receipt),
    schemaEvidence: Object.freeze({
      consumerIntegration: 4,
      managedState: 3,
      qualificationReceipt: 1,
      docsProtocol: 1,
      validated: true,
    }),
  });
}
