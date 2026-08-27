import { constants } from "node:fs";
import { cp, lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

import { assertConsumerIntegrationProfileSchema } from "../consumer-integration/adapters/consumer-integration-schema-validator.js";
import {
  checkConsumerIntegration,
  type ConsumerIntegrationDesiredStateV1
} from "../consumer-integration/index.js";
import type { DocsNewRequest } from "../domain/model.js";
import {
  applyReachability,
  changedPaths,
  fileSnapshot,
  isQualificationEvidenceExcludedPath,
  qualificationEvidencePolicy,
  type QualificationEvidenceEntryKind,
  type QualificationEvidencePolicy,
  snapshot
} from "./filesystem-evidence.js";
import {
  bootstrapQualificationInstallation,
  createProtocol,
  digest,
  documentResult,
  interruptAndRecover,
  readContainedBoundedFile,
  requireSuccess,
  signalOption
} from "./qualification-runtime.js";
import type {
  DocsProtocolQualificationContractV2,
  DocsProtocolQualificationReceiptV2,
  DocsProtocolQualificationScenarioV2,
  DocsProtocolQualificationV2Request
} from "./v2-contract.js";

type ManagedIntegrationCandidate = Omit<ConsumerIntegrationDesiredStateV1, "schemaVersion"> & {
  readonly schemaVersion: unknown;
  readonly qualification?: {
    readonly contractPath: "architecture/foundation/docs-protocol-qualification.json";
    readonly gateCommand: "pnpm docs:protocol:check";
  };
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readQualificationContractV2(root: string, path: string): Promise<{
  readonly contract: DocsProtocolQualificationContractV2;
  readonly evidence: { readonly path: string; readonly digest: `sha256:${string}` };
}> {
  const source = await readContainedBoundedFile(root, path, "Qualification contract");
  const value = JSON.parse(source.bytes.toString("utf8")) as { readonly schemaVersion?: unknown };
  if (value.schemaVersion === 1) {
    throw new Error("DOCS_QUALIFICATION_V1_MIGRATION_REQUIRED: replace fixtureRoot/tests/pins/paths/gate with schemaVersion 2 scenarios; managed integration owns package and route authority.");
  }
  const schema = JSON.parse(await readFile(new URL("../../schemas/docs-protocol-qualification/v2.schema.json", import.meta.url), "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(value)) {
    const details = (validate.errors ?? []).slice(0, 8).map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? "is invalid"}`).join("; ");
    throw new TypeError(`docs-protocol-qualification/v2 validation failed: ${details}`);
  }
  return Object.freeze({
    contract: value as DocsProtocolQualificationContractV2,
    evidence: Object.freeze({ path: source.path, digest: source.digest })
  });
}

async function copyDisposableConsumer(
  sourceRoot: string,
  consumerRoot: string,
  policy: QualificationEvidencePolicy
): Promise<void> {
  await cp(sourceRoot, consumerRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
    dereference: false,
    async filter(source) {
      const repositoryPath = relative(sourceRoot, source).split(sep).join("/");
      if (repositoryPath === "") {return true;}
      const metadata = await lstat(source);
      const entryKind: QualificationEvidenceEntryKind = metadata.isDirectory() ? "directory"
        : metadata.isFile() ? "file"
          : metadata.isSymbolicLink() ? "symbolic-link"
            : "other";
      return !await isQualificationEvidenceExcludedPath(sourceRoot, repositoryPath, policy, "source", entryKind);
    }
  });
}

export async function overlayLocalDevelopmentSkill(consumerRoot: string, skillPath: string, enabled: boolean): Promise<void> {
  if (!enabled) {return;}
  const target = join(consumerRoot, skillPath);
  const canonicalSkill = await readFile(new URL("../../skills/docs/SKILL.md", import.meta.url));
  let handle;
  try {
    handle = await open(target, constants.O_WRONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const [opened, named] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(target, { bigint: true })
    ]);
    if (!opened.isFile() || opened.nlink !== 1n || !named.isFile() || named.isSymbolicLink() ||
      opened.dev !== named.dev || opened.ino !== named.ino || opened.birthtimeNs !== named.birthtimeNs) {
      throw new Error("unsafe Skill target");
    }
    await handle.truncate(0);
    await handle.writeFile(canonicalSkill);
    const written = await handle.stat({ bigint: true });
    if (!written.isFile() || written.nlink !== 1n || written.dev !== opened.dev || written.ino !== opened.ino ||
      written.birthtimeNs !== opened.birthtimeNs || written.size !== BigInt(canonicalSkill.byteLength)) {
      throw new Error("unstable Skill target");
    }
  } catch (cause) {
    throw new Error("Local-development qualification Skill target must be one stable, non-hardlinked regular file.", { cause });
  } finally {
    await handle?.close();
  }
}

function scenarioRequest(
  scenario: DocsProtocolQualificationScenarioV2,
  consumerRoot: string,
  profilePath: string,
  signal?: AbortSignal
): Omit<DocsNewRequest, "apply"> {
  return {
    consumerRoot,
    profilePath,
    intent: {
      type: scenario.type,
      id: scenario.intent.id,
      title: scenario.intent.title,
      owner: scenario.intent.owner,
      summary: scenario.intent.summary,
      ...(scenario.intent.slug === undefined ? {} : { slug: scenario.intent.slug }),
      ...(scenario.intent.destination === undefined ? {} : { destination: scenario.intent.destination })
    },
    ...(scenario.intent.related === undefined ? {} : { related: scenario.intent.related }),
    ...(scenario.intent.blockedBy === undefined ? {} : { blockedBy: scenario.intent.blockedBy }),
    ...(scenario.intent.codeAnchors === undefined ? {} : { codeAnchors: scenario.intent.codeAnchors }),
    ...(scenario.intent.metadata === undefined ? {} : { additionalMetadata: scenario.intent.metadata }),
    ...(signal === undefined ? {} : { signal })
  };
}

type CompiledDocumentResult = ReturnType<typeof documentResult> & {
  readonly compiled: { readonly document: { readonly content: string; readonly digest: string } };
};

function assertExpectedScenario(scenario: DocsProtocolQualificationScenarioV2, result: CompiledDocumentResult): void {
  if (result.documentPath !== scenario.expected.documentPath) {
    throw new Error(`Qualification scenario ${scenario.id} path mismatch: ${result.documentPath}.`);
  }
  if (canonicalJson(result.reachability) !== canonicalJson(scenario.expected.reachability)) {
    throw new Error(`Qualification scenario ${scenario.id} reachability mismatch.`);
  }
  if (scenario.expected.goldenDigest !== undefined && result.compiled.document.digest !== scenario.expected.goldenDigest) {
    throw new Error(`Qualification scenario ${scenario.id} golden digest mismatch.`);
  }
}

function assertScenarioCoverage(contract: DocsProtocolQualificationContractV2, declaredTypes: readonly string[]): void {
  const scenarioTypes = contract.scenarios.map(({ type }) => type);
  if (new Set(contract.scenarios.map(({ id }) => id)).size !== contract.scenarios.length ||
    new Set(scenarioTypes).size !== scenarioTypes.length || canonicalJson(scenarioTypes.toSorted()) !== canonicalJson(declaredTypes.toSorted())) {
    throw new Error(`Qualification scenarios must cover every authorable type exactly once; expected ${declaredTypes.join(", ")}.`);
  }
}

async function assertManagedIntegrationAuthority(integration: ManagedIntegrationCandidate): Promise<void> {
  await assertConsumerIntegrationProfileSchema(integration);
  if (integration.schemaVersion !== 2 || integration.qualification === undefined) {
    throw new Error("DOCS_QUALIFICATION_V1_MIGRATION_REQUIRED: managed integration schemaVersion 2 with qualification authority is required.");
  }
}

async function assertReleasedIntegrationCurrent(sourceRoot: string, integrationPath: string): Promise<void> {
  const managed = await checkConsumerIntegration({
    consumerRoot: sourceRoot,
    integrationProfilePath: integrationPath
  });
  if (managed.outcome !== "current") {
    throw new Error(`Released-cohort qualification requires a current exact managed integration: ${JSON.stringify(managed.issues)}.`);
  }
}

async function qualifyScenarios(input: {
  readonly base: { readonly consumerRoot: string; readonly profilePath: string; readonly signal?: AbortSignal };
  readonly contract: DocsProtocolQualificationContractV2;
  readonly evidencePolicy: QualificationEvidencePolicy;
  readonly protocol: ReturnType<typeof createProtocol>;
}): Promise<readonly { readonly id: string; readonly type: string; readonly documentPath: string; readonly outputDigest: string }[]> {
  const receipts: { id: string; type: string; documentPath: string; outputDigest: string }[] = [];
  for (const [index, scenario] of input.contract.scenarios.entries()) {
    const scenarioBase = scenarioRequest(scenario, input.base.consumerRoot, input.base.profilePath, input.base.signal);
    const beforePreview = await fileSnapshot(input.base.consumerRoot, input.evidencePolicy);
    const preview = await input.protocol.newDocumentV2({ ...scenarioBase, apply: false });
    const previewResult = documentResult(preview) as CompiledDocumentResult;
    if (changedPaths(beforePreview, await fileSnapshot(input.base.consumerRoot, input.evidencePolicy)).length !== 0) {
      throw new Error(`Qualification scenario ${scenario.id} preview mutated the disposable consumer.`);
    }
    assertExpectedScenario(scenario, previewResult);
    if (scenario.expected.goldenFile !== undefined) {
      const golden = await readContainedBoundedFile(input.base.consumerRoot, scenario.expected.goldenFile, `Qualification scenario ${scenario.id} golden file`);
      if (golden.bytes.toString("utf8") !== previewResult.compiled.document.content) {
        throw new Error(`Qualification scenario ${scenario.id} golden file mismatch.`);
      }
    }
    if (index === 0) {
      await interruptAndRecover({
        base: scenarioBase,
        consumerRoot: input.base.consumerRoot,
        previewResult,
        profilePath: input.base.profilePath,
        protocol: input.protocol
      });
    } else {
      const applied = await input.protocol.newDocumentV2({ ...scenarioBase, apply: true });
      const appliedResult = documentResult(applied) as CompiledDocumentResult;
      if (appliedResult.planDigest !== previewResult.planDigest || appliedResult.compiled.document.content !== previewResult.compiled.document.content) {
        throw new Error(`Qualification scenario ${scenario.id} preview/apply parity mismatch.`);
      }
    }
    const actual = await readFile(join(input.base.consumerRoot, previewResult.documentPath), "utf8");
    if (actual !== previewResult.compiled.document.content) {
      throw new Error(`Qualification scenario ${scenario.id} materialized bytes differ from preview.`);
    }
    await applyReachability(input.base.consumerRoot, previewResult.reachability);
    requireSuccess(`check after ${scenario.id}`, await input.protocol.checkV2(input.base));
    receipts.push({
      id: scenario.id,
      type: scenario.type,
      documentPath: previewResult.documentPath,
      outputDigest: previewResult.compiled.document.digest
    });
  }
  return Object.freeze(receipts.map((receipt) => Object.freeze(receipt)));
}

async function collectEvidence(input: {
  readonly consumerRoot: string;
  readonly integration: ManagedIntegrationCandidate & { readonly qualification: NonNullable<ManagedIntegrationCandidate["qualification"]> };
}): Promise<{
  readonly executingModule: Buffer;
  readonly lockfileDigest: `sha256:${string}`;
  readonly packageManifestDigest: `sha256:${string}`;
  readonly profile: { readonly path: string; readonly digest: `sha256:${string}` };
  readonly skill: { readonly path: string; readonly digest: `sha256:${string}` };
}> {
  const [profile, skill, packageManifest, lockfile, executingModule] = await Promise.all([
    readContainedBoundedFile(input.consumerRoot, input.integration.profilePath, "Docs Protocol profile"),
    readContainedBoundedFile(input.consumerRoot, input.integration.skillPath, "Documentation Skill"),
    readContainedBoundedFile(input.consumerRoot, "package.json", "Package manifest"),
    readContainedBoundedFile(input.consumerRoot, "pnpm-lock.yaml", "pnpm lockfile", 64 * 1024 * 1024),
    readFile(fileURLToPath(import.meta.url))
  ]);
  return {
    executingModule,
    lockfileDigest: lockfile.digest,
    packageManifestDigest: packageManifest.digest,
    profile: { path: profile.path, digest: profile.digest },
    skill: { path: skill.path, digest: skill.digest }
  };
}

export async function runDocsProtocolQualificationV2(
  request: DocsProtocolQualificationV2Request
): Promise<DocsProtocolQualificationReceiptV2> {
  const sourceRoot = await realpath(resolvePath(request.consumerRoot));
  const integrationPath = request.integrationPath ?? "architecture/foundation/docs-consumer-integration.json";
  const integrationFile = await readContainedBoundedFile(sourceRoot, integrationPath, "Managed integration profile");
  const integration = JSON.parse(integrationFile.bytes.toString("utf8")) as ManagedIntegrationCandidate;
  await assertManagedIntegrationAuthority(integration);
  const qualifiedIntegration = integration as ManagedIntegrationCandidate & {
    readonly schemaVersion: 2;
    readonly qualification: NonNullable<ManagedIntegrationCandidate["qualification"]>;
  };
  const evidencePolicy = qualificationEvidencePolicy(qualifiedIntegration.governedDocsRoots ?? []);
  const before = await snapshot(sourceRoot, evidencePolicy) as `sha256:${string}`;
  const qualification = await readQualificationContractV2(sourceRoot, qualifiedIntegration.qualification.contractPath);
  if (request.localDevelopment !== true) {
    await assertReleasedIntegrationCurrent(sourceRoot, integrationPath);
  }
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "atd-q2-")));
  const consumerRoot = join(temporary, "consumer");
  try {
    request.signal?.throwIfAborted();
    await copyDisposableConsumer(sourceRoot, consumerRoot, evidencePolicy);
    const executingPackages = await bootstrapQualificationInstallation(consumerRoot, request.localDevelopment === true);
    await overlayLocalDevelopmentSkill(consumerRoot, qualifiedIntegration.skillPath, request.localDevelopment === true);
    const manifest = JSON.parse(await readFile(join(consumerRoot, "package.json"), "utf8")) as { readonly scripts?: Readonly<Record<string, unknown>> };
    if (typeof manifest.scripts?.["docs:protocol:check"] !== "string") {
      throw new Error(`Managed qualification gate ${qualifiedIntegration.qualification.gateCommand} must resolve to a package script; it is never executed by qualification.`);
    }
    const protocol = createProtocol();
    const base = { consumerRoot, profilePath: qualifiedIntegration.profilePath, ...signalOption(request.signal) };
    const info = await protocol.infoV2(base);
    requireSuccess("info", info);
    const infoResult = info.envelope.result;
    assertScenarioCoverage(qualification.contract, infoResult.types.map(({ type }) => type));
    requireSuccess("find", await protocol.findV2({ ...base, query: {} }));
    requireSuccess("check", await protocol.checkV2(base));
    const initialDoctor = await protocol.doctorV2(base);
    requireSuccess("doctor", initialDoctor);
    const idleRecovery = await protocol.recoverV2(base);
    requireSuccess("recover", idleRecovery);
    if (idleRecovery.envelope.result.transactionState !== "no-pending-transaction") {
      throw new Error("Qualification recover did not prove the initial idle state.");
    }
    const receipts = await qualifyScenarios({ base, contract: qualification.contract, evidencePolicy, protocol });
    requireSuccess("doctor", await protocol.doctorV2(base));
    requireSuccess("recover", await protocol.recoverV2(base));
    if (await snapshot(sourceRoot, evidencePolicy) !== before) {
      throw new Error("Qualification modified its source consumer.");
    }
    const evidence = await collectEvidence({
      consumerRoot,
      integration: qualifiedIntegration
    });
    const environment = initialDoctor.envelope.result.environment as {
      readonly installedFoundationBuildIdentity: `sha256:${string}`;
      readonly installedFoundationVersion: string;
    };
    if (request.localDevelopment !== true && (
      executingPackages.docsVersion !== qualifiedIntegration.cohort.packages.docsProtocol.version ||
      executingPackages.foundationVersion !== qualifiedIntegration.cohort.packages.engineeringFoundation.version ||
      environment.installedFoundationVersion !== qualifiedIntegration.cohort.packages.engineeringFoundation.version
    )) {
      throw new Error("Released-cohort qualification execution identity does not match the exact cohort package versions.");
    }
    const hasGolden = qualification.contract.scenarios.some(({ expected }) =>
      expected.goldenFile !== undefined || expected.goldenDigest !== undefined);
    const body = Object.freeze({
      schemaVersion: 2,
      cohortAdmissible: request.localDevelopment !== true,
      evidenceClass: request.localDevelopment === true ? "local-development" : "released-cohort",
      projectId: infoResult.projectId,
      scenarios: receipts,
      checks: Object.freeze([
        "info", "find", "check", "doctor", "recover", "preview", "apply", "path", "reachability",
        ...(hasGolden ? ["golden" as const] : []),
        "source-unchanged"
      ] as const),
      derived: Object.freeze({
        contractPath: qualifiedIntegration.qualification.contractPath,
        gateCommand: qualifiedIntegration.qualification.gateCommand,
        packageVersions: Object.freeze({
          docsProtocol: qualifiedIntegration.cohort.packages.docsProtocol.version,
          engineeringFoundation: qualifiedIntegration.cohort.packages.engineeringFoundation.version
        }),
        profilePath: qualifiedIntegration.profilePath
      }),
      evidence: Object.freeze({
        sourceDigest: before,
        integration: Object.freeze({ path: integrationPath, digest: integrationFile.digest }),
        contract: qualification.evidence,
        profile: Object.freeze(evidence.profile),
        skill: Object.freeze(evidence.skill),
        packageManifestDigest: evidence.packageManifestDigest,
        lockfileDigest: evidence.lockfileDigest,
        executingDocsProtocol: Object.freeze({ version: executingPackages.docsVersion, buildDigest: digest(evidence.executingModule) }),
        executingFoundation: Object.freeze({
          version: environment.installedFoundationVersion,
          buildIdentity: environment.installedFoundationBuildIdentity
        }),
        cohort: Object.freeze({ ...qualifiedIntegration.cohort })
      })
    });
    return Object.freeze({ ...body, receiptDigest: digest(canonicalJson(body)) });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
