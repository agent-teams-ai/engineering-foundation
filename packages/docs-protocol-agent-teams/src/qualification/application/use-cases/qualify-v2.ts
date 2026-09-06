import {
  changedPaths, digest, documentResult, qualificationEvidencePolicy, requireSuccess, signalOption,
  type DocsNewRequest, type PortableQualificationProtocol, type QualificationEvidencePolicy
} from "@agent-teams/docs-protocol/qualification";
import type { ManagedQualificationIntegration, DocsProtocolQualificationContractV2, DocsProtocolQualificationScenarioV2, DocsProtocolQualificationV2Request, DocsProtocolQualificationReceiptV2 } from "../model/v2-contract.js";
import type { ManagedIntegrationCandidate, QualifiedManagedIntegration, ManagedQualificationEnvironment } from "../model/managed-environment.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

async function assertManagedIntegrationAuthority(integration: ManagedIntegrationCandidate, integrationApi: ManagedQualificationIntegration): Promise<void> {
  await integrationApi.assertProfile(integration);
  if (integration.schemaVersion !== 2 || integration.qualification === undefined) {
    throw new Error("DOCS_QUALIFICATION_V1_MIGRATION_REQUIRED: managed integration schemaVersion 2 with qualification authority is required.");
  }
}

async function assertReleasedIntegrationCurrent(sourceRoot: string, integrationPath: string, integrationApi: ManagedQualificationIntegration): Promise<void> {
  const managed = await integrationApi.check({
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
  readonly protocol: PortableQualificationProtocol;
  readonly environment: ManagedQualificationEnvironment;
}): Promise<readonly { readonly id: string; readonly type: string; readonly documentPath: string; readonly outputDigest: string }[]> {
  const receipts: { id: string; type: string; documentPath: string; outputDigest: string }[] = [];
  for (const [index, scenario] of input.contract.scenarios.entries()) {
    const scenarioBase = scenarioRequest(scenario, input.base.consumerRoot, input.base.profilePath, input.base.signal);
    const beforePreview = await input.environment.fileSnapshot(input.base.consumerRoot, input.evidencePolicy);
    const preview = await input.protocol.newDocumentV2({ ...scenarioBase, apply: false });
    const previewResult = documentResult(preview) as CompiledDocumentResult;
    if (changedPaths(beforePreview, await input.environment.fileSnapshot(input.base.consumerRoot, input.evidencePolicy)).length !== 0) {
      throw new Error(`Qualification scenario ${scenario.id} preview mutated the disposable consumer.`);
    }
    assertExpectedScenario(scenario, previewResult);
    if (scenario.expected.goldenFile !== undefined) {
      const golden = await input.environment.readGolden(input.base.consumerRoot, scenario.expected.goldenFile, `Qualification scenario ${scenario.id} golden file`);
      if (golden !== previewResult.compiled.document.content) {
        throw new Error(`Qualification scenario ${scenario.id} golden file mismatch.`);
      }
    }
    if (index === 0) {
      await input.environment.interruptAndRecover({
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
    const actual = await input.environment.readDocument(input.base.consumerRoot, previewResult.documentPath);
    if (actual !== previewResult.compiled.document.content) {
      throw new Error(`Qualification scenario ${scenario.id} materialized bytes differ from preview.`);
    }
    await input.environment.applyReachability(input.base.consumerRoot, previewResult.reachability);
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

export function createDocsProtocolQualificationV2(dependencies: { readonly integrationApi: ManagedQualificationIntegration; readonly environment: ManagedQualificationEnvironment }) {
  const { integrationApi, environment } = dependencies;
  return async function runDocsProtocolQualificationV2(
    request: DocsProtocolQualificationV2Request
  ): Promise<DocsProtocolQualificationReceiptV2> {
    const sourceRoot = await environment.resolveRoot(request.consumerRoot);
    const integrationPath = request.integrationPath ?? "architecture/foundation/docs-consumer-integration.json";
    const integrationFile = await environment.readIntegration(sourceRoot, integrationPath);
    const integration = integrationFile.value;
    await assertManagedIntegrationAuthority(integration, integrationApi);
    const qualifiedIntegration = integration as QualifiedManagedIntegration;
    const evidencePolicy = qualificationEvidencePolicy(qualifiedIntegration.governedDocsRoots ?? []);
    const before = await environment.snapshot(sourceRoot, evidencePolicy) as `sha256:${string}`;
    const qualification = await environment.readContract(sourceRoot, qualifiedIntegration.qualification.contractPath);
    if (request.localDevelopment !== true) {
      await assertReleasedIntegrationCurrent(sourceRoot, integrationPath, integrationApi);
    }
    const disposable = await environment.createDisposable();
    const { consumerRoot } = disposable;
    try {
      request.signal?.throwIfAborted();
      await disposable.copyFrom(sourceRoot, evidencePolicy);
      const executingPackages = await environment.bootstrapInstallation(
        consumerRoot,
        request.localDevelopment === true
      );
      await environment.overlaySkill(consumerRoot, qualifiedIntegration.skillPath, request.localDevelopment === true);
      const scripts = await environment.readScripts(consumerRoot);
      if (typeof scripts?.["docs:protocol:check"] !== "string") {
        throw new Error(`Managed qualification gate ${qualifiedIntegration.qualification.gateCommand} must resolve to a package script; it is never executed by qualification.`);
      }
      const { protocol } = environment;
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
      const receipts = await qualifyScenarios({ base, contract: qualification.contract, evidencePolicy, protocol, environment });
      requireSuccess("doctor", await protocol.doctorV2(base));
      requireSuccess("recover", await protocol.recoverV2(base));
      if (await environment.snapshot(sourceRoot, evidencePolicy) !== before) {
        throw new Error("Qualification modified its source consumer.");
      }
      const evidence = await environment.collectEvidence({
        consumerRoot,
        integration: qualifiedIntegration
      });
      const installedEnvironment = initialDoctor.envelope.result.environment as {
        readonly installedFoundationBuildIdentity: `sha256:${string}`;
        readonly installedFoundationVersion: string;
      };
      if (request.localDevelopment !== true &&
        executingPackages.docsVersion !== qualifiedIntegration.cohort.packages.docsProtocol.version) {
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
          integration: Object.freeze({ path: integrationPath, digest: integrationFile.evidence.digest }),
          contract: qualification.evidence,
          profile: Object.freeze(evidence.profile),
          skill: Object.freeze(evidence.skill),
          packageManifestDigest: evidence.packageManifestDigest,
          lockfileDigest: evidence.lockfileDigest,
          executingDocsProtocol: Object.freeze({
            version: executingPackages.docsVersion,
            buildDigest: digest(canonicalJson({
              "adapters/outbound/node-managed-qualification.js": digest(evidence.executingModule),
              "application/use-cases/qualify-v2.js": digest(evidence.executingApplication)
            }))
          }),
          executingFoundation: Object.freeze({
            version: installedEnvironment.installedFoundationVersion,
            buildIdentity: installedEnvironment.installedFoundationBuildIdentity
          }),
          cohort: Object.freeze({ ...qualifiedIntegration.cohort })
        })
      });
      return Object.freeze({ ...body, receiptDigest: digest(canonicalJson(body)) });
    } finally {
      await disposable.dispose();
    }
  };
}
