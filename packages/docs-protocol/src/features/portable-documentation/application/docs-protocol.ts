import {
  DOCS_PROTOCOL_ID,
  DOCS_PROTOCOL_VERSION,
  type DocsDiagnostic,
  type DocsFindQuery,
  type DocsNewRequest,
  type CodeAnchorMatcher,
  type DocsAdoptionInspector,
} from "./model.js";
import type { DocsNewResultV2, DocsProfileReaderV2 } from "./model-v2.js";
import type {
  DocsContextRequestV1,
  DocsContextResultV1,
  DocsFindQueryV3,
  DocsFindResultV3,
  DocumentAuthoringPortV3,
} from "./model-v3.js";
import { profileBlockerPolicy } from "../domain/blocker-policy.js";
import { inspectCorpusSemantics } from "./docs-new-completion.js";
import type { DocsOperationResult } from "./docs-execution.js";
import { compatibleProfileV2, execution } from "./docs-execution.js";
import type { CompiledOutputReader } from "./compiled-output-reader.js";
import type { CommunitySearchIndex } from "./ranked-search.js";
import { projectCommunityContext, projectCommunityFind, projectLegacyFind } from "./context.js";
import {
  withSignal,
  projectTransaction,
  receiptOutcome,
  receiptDiagnostics,
  receiptEvidence,
  recoveryWriteState,
} from "./docs-authoring-policy.js";
import { newDocumentV2 } from "./docs-new.js";

export class DocsProtocol {
  readonly #compiledOutput: CompiledOutputReader;
  readonly #searchIndex: CommunitySearchIndex;
  readonly #adoption: DocsAdoptionInspector;
  readonly #anchors: CodeAnchorMatcher;
  readonly #foundation: DocumentAuthoringPortV3;
  readonly #profiles: DocsProfileReaderV2;

  constructor(input: {
    readonly compiledOutput: CompiledOutputReader;
    readonly searchIndex: CommunitySearchIndex;
    readonly adoption: DocsAdoptionInspector;
    readonly anchors: CodeAnchorMatcher;
    readonly foundation: DocumentAuthoringPortV3;
    readonly profiles: DocsProfileReaderV2;
  }) {
    this.#compiledOutput = input.compiledOutput;
    this.#searchIndex = input.searchIndex;
    this.#adoption = input.adoption;
    this.#anchors = input.anchors;
    this.#foundation = input.foundation;
    this.#profiles = input.profiles;
  }

  async infoV2(input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }) {
    const profile = await this.#profiles.read(input);
    const compatibleProfile = compatibleProfileV2(profile);
    const description = await this.#foundation.describe({
      consumerRoot: input.consumerRoot,
      profilePath: profile.foundationProfile.path,
      profileSchemaVersion: profile.foundationProfile.schemaVersion,
      ...withSignal(input.signal),
    });
    const result = Object.freeze({
      kind: "info" as const,
      projectId: description.projectId,
      protocol: compatibleProfile.protocol,
      foundationProfile: compatibleProfile.foundationProfile,
      agentWorkflow: compatibleProfile.agentWorkflow,
      authority: description.authority,
      authorityPaths: description.authorityPaths,
      catalog: description.catalog,
      semanticDigest: description.semanticDigest,
      metadataSchemaPath: description.metadataSchemaPath,
      metadataSidecar: description.metadataSidecar,
      ownerIds: description.ownerIds,
      types: description.types,
      semanticValidatorIds: compatibleProfile.semanticValidatorIds,
    });
    return execution("docs.info", "success", result);
  }

  async findV2(input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly query: DocsFindQuery;
    readonly signal?: AbortSignal;
  }) {
    const profile = await this.#profiles.read(input);
    const authority = profile.foundationProfile;
    await this.#foundation.describe({
      consumerRoot: input.consumerRoot,
      profilePath: authority.path,
      profileSchemaVersion: authority.schemaVersion,
      ...withSignal(input.signal),
    });
    const projection = await projectLegacyFind({
      consumerRoot: input.consumerRoot,
      foundation: this.#foundation,
      foundationProfilePath: authority.path,
      query: input.query,
      ...withSignal(input.signal),
    });
    return execution("docs.find", "success", projection.result, projection.diagnostics);
  }

  async findV3(input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly query: DocsFindQueryV3;
    readonly signal?: AbortSignal;
  }): Promise<DocsOperationResult<DocsFindResultV3, "docs.find">> {
    const profile = await this.#profiles.read(input);
    const authority = profile.foundationProfile;
    await this.#foundation.describe({
      consumerRoot: input.consumerRoot,
      profilePath: authority.path,
      profileSchemaVersion: authority.schemaVersion,
      ...withSignal(input.signal),
    });
    const projection = await projectCommunityFind({
      searchIndex: this.#searchIndex,
      consumerRoot: input.consumerRoot,
      foundation: this.#foundation,
      foundationProfilePath: authority.path,
      query: input.query,
      ...withSignal(input.signal),
    });
    return execution("docs.find", projection.outcome, projection.result, projection.diagnostics);
  }

  async contextV1(
    input: DocsContextRequestV1,
  ): Promise<DocsOperationResult<DocsContextResultV1, "docs.context">> {
    const profile = await this.#profiles.read(input);
    const authority = profile.foundationProfile;
    const catalogBefore = await this.#foundation.buildCatalog({
      consumerRoot: input.consumerRoot,
      profilePath: authority.path,
      ...withSignal(input.signal),
    });
    const projection = await projectCommunityContext({
      searchIndex: this.#searchIndex,
      catalogBefore,
      foundation: this.#foundation,
      foundationProfilePath: authority.path,
      request: input,
    });
    return execution("docs.context", projection.outcome, projection.result, projection.diagnostics);
  }

  async newDocumentV2(
    request: DocsNewRequest,
  ): Promise<DocsOperationResult<DocsNewResultV2, "docs.new">> {
    return newDocumentV2(request, {
      compiledOutput: this.#compiledOutput,
      adoption: this.#adoption,
      anchors: this.#anchors,
      foundation: this.#foundation,
      profiles: this.#profiles,
    });
  }

  async doctorV2(input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }) {
    const [environment, inspection] = await Promise.all([
      this.#foundation.inspectEnvironment({
        consumerRoot: input.consumerRoot,
        ...withSignal(input.signal),
      }),
      this.#foundation.inspect(input.consumerRoot),
    ]);
    let projectId: string | undefined;
    let diagnostics: readonly DocsDiagnostic[] = [];
    try {
      const profile = await this.#profiles.read(input);
      const description = await this.#foundation.describe({
        consumerRoot: input.consumerRoot,
        profilePath: profile.foundationProfile.path,
        profileSchemaVersion: profile.foundationProfile.schemaVersion,
        ...withSignal(input.signal),
      });
      projectId = description.projectId;
      diagnostics = await this.#adoption.inspect({
        policy: profile.adoptionPolicy,
        authorityPaths: description.authorityPaths,
        consumerRoot: input.consumerRoot,
        profilePath: input.profilePath,
        skillPath: profile.agentWorkflow.skillPath,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      diagnostics = Object.freeze([
        {
          ruleId: "docs.doctor.authority-unavailable",
          severity: "error",
          phase: "authority",
          subject: input.profilePath,
          message:
            error instanceof Error
              ? error.message
              : "Documentation authoring authority is unavailable.",
        },
      ]);
    }
    const outcome =
      inspection.state !== "idle"
        ? "recovery-required"
        : diagnostics.some(({ severity }) => severity === "error")
          ? "violation"
          : "success";
    return execution(
      "docs.doctor",
      outcome,
      Object.freeze({
        kind: "doctor" as const,
        protocol: Object.freeze({ id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION }),
        ...(projectId === undefined ? {} : { projectId }),
        environment,
        transaction: projectTransaction(inspection),
      }),
      diagnostics,
    );
  }

  async recoverV2(input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }) {
    const inspection = await this.#foundation.inspect(input.consumerRoot);
    if (inspection.state === "idle") {
      return execution(
        "docs.recover",
        "success",
        Object.freeze({
          kind: "recover" as const,
          transactionState: "no-pending-transaction" as const,
          writeState: "unchanged" as const,
        }),
      );
    }
    if (inspection.state !== "recoverable") {
      return execution(
        "docs.recover",
        "recovery-required",
        Object.freeze({
          kind: "recover" as const,
          transactionState: "manual-required" as const,
          writeState: "unknown" as const,
          transaction: projectTransaction(inspection),
        }),
      );
    }
    const receipt = await this.#foundation.recover({
      consumerRoot: input.consumerRoot,
      ...withSignal(input.signal),
    });
    return execution(
      "docs.recover",
      receiptOutcome(receipt),
      Object.freeze({
        kind: "recover" as const,
        transactionState:
          receipt.outcome === "applied" || receipt.outcome === "already-applied"
            ? ("recovered" as const)
            : ("recovery-required" as const),
        writeState: recoveryWriteState(receipt),
        receiptDigest: receipt.receiptDigest,
        receipt: receiptEvidence(receipt),
      }),
      receiptDiagnostics(receipt),
    );
  }

  async checkV2(input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }) {
    const profile = await this.#profiles.read(input);
    const compatibleProfile = compatibleProfileV2(profile);
    const description = await this.#foundation.describe({
      consumerRoot: input.consumerRoot,
      profilePath: profile.foundationProfile.path,
      profileSchemaVersion: profile.foundationProfile.schemaVersion,
      ...withSignal(input.signal),
    });
    const catalog = await this.#foundation.buildCatalog({
      consumerRoot: input.consumerRoot,
      profilePath: profile.foundationProfile.path,
      ...withSignal(input.signal),
    });
    input.signal?.throwIfAborted();
    const semanticDiagnostics = await inspectCorpusSemantics({
      anchors: this.#anchors,
      catalog,
      policy: profileBlockerPolicy(profile),
      consumerRoot: input.consumerRoot,
      ...withSignal(input.signal),
    });
    const adoptionDiagnostics = await this.#adoption.inspect({
      policy: profile.adoptionPolicy,
      authorityPaths: description.authorityPaths,
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      skillPath: profile.agentWorkflow.skillPath,
    });
    const transaction = await this.#foundation.inspect(input.consumerRoot);
    const diagnostics: DocsDiagnostic[] = [
      ...catalog.diagnostics.map((entry) => ({ ...entry, phase: "authority" as const })),
      ...semanticDiagnostics,
      ...adoptionDiagnostics,
      ...(transaction.state === "idle"
        ? []
        : [
            {
              ruleId: "docs.adoption.recovery-state-active",
              severity: "error" as const,
              phase: "recovery" as const,
              subject: "foundation.transaction",
              message:
                "Active or preserved Foundation recovery state must be resolved before docs:check succeeds.",
            },
          ]),
    ];
    const valid =
      catalog.status === "complete" &&
      catalog.projectId === description.projectId &&
      !diagnostics.some(({ severity }) => severity === "error");
    return execution(
      "docs.check",
      valid ? "success" : "violation",
      Object.freeze({
        kind: "check" as const,
        projectId: description.projectId,
        catalogStatus: catalog.status,
        documents: catalog.documents.length,
        foundationProfile: compatibleProfile.foundationProfile,
        metadataSidecar: description.metadataSidecar,
        semanticValidatorIds: compatibleProfile.semanticValidatorIds,
        valid,
      }),
      diagnostics,
    );
  }
}
