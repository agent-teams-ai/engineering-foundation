import type {
  DocumentAuthorityEvidence,
  DocumentIdentityProjectionEntry,
  DocumentationCatalogSnapshot
} from "../model/document-catalog.js";
import type {
  DocumentArtifactType,
  DocumentIntent,
  DocumentPlan,
  DocumentPlanningProfileSnapshot
} from "../model/document-planning.js";
import type { CanonicalDocumentRenderer } from "../ports/canonical-document-renderer.js";
import type { DocumentContractValidator } from "../ports/document-contract-validator.js";
import type { DocumentPlanningProfileReader } from "../ports/document-planning-profile-reader.js";
import type { DocumentPlanningStateReader } from "../ports/document-planning-state-reader.js";
import type { DocumentTemplateReader } from "../ports/document-template-reader.js";
import type { DocumentationCatalogReader } from "../ports/documentation-catalog-reader.js";
import type { MetadataInstanceValidator } from "../ports/metadata-instance-validator.js";
import type { OwnerMembershipReader } from "../ports/owner-membership-reader.js";
import { assertDocumentPlanDigests } from "../policies/document-contract-digests.js";
import { DocumentPlanningError } from "../../document-planning-error.js";
import { compileDocumentPlan } from "./compile-document-plan.js";

export interface ResolvedDocumentAuthoring {
  readonly artifact: DocumentArtifactType;
  readonly slug?: string;
  readonly destination: string;
  readonly heading: string;
}

export interface DocumentLogicalPreimage {
  readonly identityProjection: readonly DocumentIdentityProjectionEntry[];
  readonly isExactSelf: boolean;
}

/**
 * Closed pure policy surface consumed by the read-only orchestration use case.
 * Implementations live in the policy layer; consumer code cannot supply it from
 * the public composition root.
 */
export interface DocumentPlanningPolicies {
  normalizeDocumentIntent(input: DocumentIntent): DocumentIntent;
  selectDocumentArtifact(
    profile: DocumentPlanningProfileSnapshot,
    type: string
  ): DocumentArtifactType;
  resolveDocumentAuthoring(input: {
    readonly artifact: DocumentArtifactType;
    readonly intent: DocumentIntent;
  }): ResolvedDocumentAuthoring;
  isDestinationCoveredByCatalog(
    destination: string,
    collections: DocumentPlanningProfileSnapshot["collections"],
    excludedPrefixes: readonly string[]
  ): boolean;
  classifyDocumentLogicalPreimage(input: {
    readonly catalog: DocumentationCatalogSnapshot;
    readonly id: string;
    readonly destination: string;
    readonly observedBytes?: Uint8Array;
    readonly expectedBytes: Uint8Array;
  }): DocumentLogicalPreimage;
}

export interface PlanDocumentationDocumentRequest {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly intent: unknown;
  readonly signal?: AbortSignal;
}

interface Dependencies {
  readonly catalog: DocumentationCatalogReader;
  readonly compiler: DocumentPlan["compiler"];
  readonly contracts: DocumentContractValidator;
  readonly metadata: MetadataInstanceValidator;
  readonly owners: OwnerMembershipReader;
  readonly policies: DocumentPlanningPolicies;
  readonly profile: DocumentPlanningProfileReader;
  readonly renderer: CanonicalDocumentRenderer;
  readonly state: DocumentPlanningStateReader;
  readonly templates: DocumentTemplateReader;
}

interface LoadedPlanningAuthority {
  readonly catalog: Awaited<ReturnType<DocumentationCatalogReader["execute"]>>;
  readonly metadata: Awaited<ReturnType<MetadataInstanceValidator["load"]>>;
  readonly owners: Awaited<ReturnType<OwnerMembershipReader["read"]>>;
  readonly template: Awaited<ReturnType<DocumentTemplateReader["read"]>>;
}

function signalOption(signal: AbortSignal | undefined): {
  readonly signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}

function sameEvidence(
  left: DocumentAuthorityEvidence,
  right: DocumentAuthorityEvidence
): boolean {
  return (
    left.path === right.path &&
    left.digest === right.digest &&
    left.size === right.size
  );
}

function assertStableEvidence(
  name: string,
  before: DocumentAuthorityEvidence,
  after: DocumentAuthorityEvidence
): void {
  if (!sameEvidence(before, after)) {
    throw new DocumentPlanningError(
      "DOCUMENT_PLANNING_AUTHORITY_CHANGED",
      `${name} changed while the document Plan was compiled.`
    );
  }
}

function outputBytes(output: string): Uint8Array {
  return new TextEncoder().encode(output);
}

async function loadPlanningAuthority(
  dependencies: Dependencies,
  request: PlanDocumentationDocumentRequest,
  profile: DocumentPlanningProfileSnapshot,
  templatePath: string
): Promise<LoadedPlanningAuthority> {
  const options = signalOption(request.signal);
  const [catalog, metadata, owners, template] = await Promise.all([
    dependencies.catalog.execute({
      consumerRoot: request.consumerRoot,
      profilePath: request.profilePath,
      ...options
    }),
    dependencies.metadata.load({
      consumerRoot: request.consumerRoot,
      path: profile.metadataSchemaPath,
      ...options
    }),
    dependencies.owners.read({
      consumerRoot: request.consumerRoot,
      contract: profile.ownerCatalog.contract,
      path: profile.ownerCatalog.path,
      ...options
    }),
    dependencies.templates.read({
      consumerRoot: request.consumerRoot,
      path: templatePath,
      ...options
    })
  ]);
  return { catalog, metadata, owners, template };
}

function assertCatalogAuthority(
  profile: DocumentPlanningProfileSnapshot,
  intent: DocumentIntent,
  authority: LoadedPlanningAuthority
): void {
  if (authority.catalog.status !== "complete") {
    throw new DocumentPlanningError(
      "DOCUMENT_PLANNING_CATALOG_PARTIAL",
      "Document planning requires a complete rebuilt catalog."
    );
  }
  assertStableEvidence(
    "Document profile",
    profile.evidence,
    authority.catalog.authority.profile
  );
  assertStableEvidence(
    "Document metadata schema",
    authority.metadata.evidence,
    authority.catalog.authority.metadataSchema
  );
  assertStableEvidence(
    "Document owner catalog",
    authority.owners.evidence,
    authority.catalog.authority.ownerCatalog
  );
  if (!authority.owners.ids.includes(intent.owner)) {
    throw new DocumentPlanningError(
      "DOCUMENT_PLANNING_INPUT_INVALID",
      `Document owner ${intent.owner} is not present in the owner catalog.`
    );
  }
}

async function recaptureAuthority(
  dependencies: Dependencies,
  request: PlanDocumentationDocumentRequest,
  profile: DocumentPlanningProfileSnapshot,
  templatePath: string,
  authority: LoadedPlanningAuthority
): Promise<void> {
  const options = signalOption(request.signal);
  const [profileAfter, metadataAfter, ownersAfter, templateAfter] =
    await Promise.all([
      dependencies.profile.read({
        consumerRoot: request.consumerRoot,
        path: request.profilePath,
        ...options
      }),
      dependencies.metadata.load({
        consumerRoot: request.consumerRoot,
        path: profile.metadataSchemaPath,
        ...options
      }),
      dependencies.owners.read({
        consumerRoot: request.consumerRoot,
        contract: profile.ownerCatalog.contract,
        path: profile.ownerCatalog.path,
        ...options
      }),
      dependencies.templates.read({
        consumerRoot: request.consumerRoot,
        path: templatePath,
        ...options
      })
    ]);
  assertStableEvidence("Document profile", profile.evidence, profileAfter.evidence);
  assertStableEvidence(
    "Document metadata schema",
    authority.metadata.evidence,
    metadataAfter.evidence
  );
  assertStableEvidence(
    "Document owner catalog",
    authority.owners.evidence,
    ownersAfter.evidence
  );
  assertStableEvidence(
    "Document template",
    authority.template.evidence,
    templateAfter.evidence
  );
}

export class PlanDocumentationDocument {
  readonly #dependencies: Dependencies;

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  async execute(
    request: PlanDocumentationDocumentRequest
  ): Promise<DocumentPlan> {
    const options = signalOption(request.signal);
    const validatedIntent = await this.#dependencies.contracts.validateIntent(
      request.intent
    );
    const intent = this.#dependencies.policies.normalizeDocumentIntent(
      validatedIntent
    );
    const profile = await this.#dependencies.profile.read({
      consumerRoot: request.consumerRoot,
      path: request.profilePath,
      ...options
    });
    const artifact = this.#dependencies.policies.selectDocumentArtifact(
      profile,
      intent.type
    );
    const resolved = this.#dependencies.policies.resolveDocumentAuthoring({
      artifact,
      intent
    });
    if (
      !this.#dependencies.policies.isDestinationCoveredByCatalog(
        resolved.destination,
        profile.collections,
        profile.excludedPrefixes
      )
    ) {
      throw new DocumentPlanningError(
        "DOCUMENT_PLANNING_INPUT_INVALID",
        "Planned destination is outside the complete documentation catalog."
      );
    }

    const authority = await loadPlanningAuthority(
      this.#dependencies,
      request,
      profile,
      resolved.artifact.template.path
    );
    assertCatalogAuthority(profile, intent, authority);
    if (authority.template.evidence.path !== resolved.artifact.template.path) {
      throw new DocumentPlanningError(
        "DOCUMENT_PLANNING_AUTHORITY_CHANGED",
        "Document template evidence does not match the selected artifact authority."
      );
    }

    const skeleton = this.#dependencies.renderer.parseTemplate(
      authority.template.source
    );
    const frontmatter = Object.freeze({
      id: intent.id,
      type: intent.type,
      status: resolved.artifact.initialStatus,
      owner: intent.owner,
      summary: intent.summary,
      ...(intent.related === undefined ? {} : { related: intent.related }),
      ...(intent.additionalMetadata === undefined
        ? {}
        : { additionalMetadata: intent.additionalMetadata })
    });
    const validation = authority.metadata.validate({
      id: frontmatter.id,
      type: frontmatter.type,
      status: frontmatter.status,
      owner: frontmatter.owner,
      summary: frontmatter.summary,
      ...(frontmatter.related === undefined ? {} : { related: frontmatter.related }),
      ...(frontmatter.additionalMetadata === undefined
        ? {}
        : frontmatter.additionalMetadata)
    });
    if (!validation.valid) {
      throw new DocumentPlanningError(
        "DOCUMENT_PLANNING_OUTPUT_INVALID",
        `Compiled document metadata is invalid: ${validation.messages.join("; ")}`
      );
    }
    const output = this.#dependencies.renderer.render({
      frontmatter,
      heading: resolved.heading,
      template: skeleton
    });
    const expectedBytes = outputBytes(output);
    const state = await this.#dependencies.state.observe({
      consumerRoot: request.consumerRoot,
      destination: resolved.destination,
      ...options
    });
    const logicalPreimage =
      this.#dependencies.policies.classifyDocumentLogicalPreimage({
        catalog: authority.catalog,
        id: intent.id,
        destination: resolved.destination,
        ...(state.destination.state === "regular-file"
          ? { observedBytes: state.destination.bytes }
          : {}),
        expectedBytes
      });
    if (
      (state.destination.state === "regular-file") !==
      logicalPreimage.isExactSelf
    ) {
      throw new DocumentPlanningError(
        "DOCUMENT_PLANNING_CONFLICT",
        "Existing destination is not the exact logical document self."
      );
    }

    await recaptureAuthority(
      this.#dependencies,
      request,
      profile,
      resolved.artifact.template.path,
      authority
    );

    const plan = compileDocumentPlan({
      catalog: authority.catalog,
      compiler: this.#dependencies.compiler,
      destination: resolved.destination,
      identityProjection: logicalPreimage.identityProjection,
      intent,
      metadataSchema: authority.metadata.evidence,
      ownerCatalog: authority.owners.evidence,
      output,
      profile,
      state,
      template: authority.template
    });
    const validatedPlan = await this.#dependencies.contracts.validatePlan(plan);
    assertDocumentPlanDigests(validatedPlan);
    return validatedPlan;
  }
}
