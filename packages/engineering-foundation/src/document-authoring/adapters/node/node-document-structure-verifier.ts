import type {
  DocumentAuthorityEvidence,
  DocumentDescriptor,
  DocumentationCatalogSnapshot,
} from "../../application/model/document-catalog.js";
import type { DocumentPlan } from "../../application/model/document-planning.js";
import type {
  DocumentStructureDiagnostic,
  DocumentStructureVerifier,
} from "../../application/ports/document-structure-verifier.js";
import type { DocumentPlanningProfileReader } from "../../application/ports/document-planning-profile-reader.js";
import type { DocumentationCatalogReader } from "../../application/ports/documentation-catalog-reader.js";
import { selectDocumentArtifact } from "../../application/policies/resolve-document-authoring.js";

function diagnostic(
  ruleId: string,
  subject: string,
  message: string,
): DocumentStructureDiagnostic {
  return Object.freeze({ ruleId, subject, message });
}

function sameEvidence(
  observed: DocumentAuthorityEvidence,
  planned: DocumentAuthorityEvidence,
): boolean {
  return observed.path === planned.path &&
    observed.digest === planned.digest &&
    observed.size === planned.size;
}

function authorityDiagnostics(
  catalog: DocumentationCatalogSnapshot,
  plan: DocumentPlan,
): readonly DocumentStructureDiagnostic[] {
  const diagnostics: DocumentStructureDiagnostic[] = [];
  if (!sameEvidence(catalog.authority.profile, plan.authority.profile)) {
    diagnostics.push(diagnostic(
      "document.new.profile-authority-mismatch",
      plan.authority.profile.path,
      "The catalog profile authority does not match the applied plan.",
    ));
  }
  if (!sameEvidence(catalog.authority.metadataSchema, plan.authority.metadataSchema)) {
    diagnostics.push(diagnostic(
      "document.new.metadata-authority-mismatch",
      plan.authority.metadataSchema.path,
      "The catalog metadata authority does not match the applied plan.",
    ));
  }
  if (!sameEvidence(catalog.authority.ownerCatalog, plan.authority.ownerCatalog)) {
    diagnostics.push(diagnostic(
      "document.new.owner-authority-mismatch",
      plan.authority.ownerCatalog.path,
      "The catalog owner authority does not match the applied plan.",
    ));
  }
  if (catalog.projectId !== plan.projectId) {
    diagnostics.push(diagnostic(
      "document.new.project-mismatch",
      plan.destination,
      "The rebuilt catalog does not identify the planned project.",
    ));
  }
  return diagnostics;
}

function descriptorMatches(
  descriptor: DocumentDescriptor,
  plan: DocumentPlan,
  initialStatus: string,
  expectedTitle: string,
): boolean {
  return descriptor.id === plan.intent.id &&
    descriptor.repositoryPath === plan.destination &&
    descriptor.type === plan.intent.type &&
    descriptor.title === expectedTitle &&
    descriptor.owner === plan.intent.owner &&
    descriptor.summary === plan.intent.summary &&
    descriptor.status === initialStatus;
}

/** Rebuilds the catalog and proves that the applied document has one exact descriptor. */
export class NodeDocumentStructureVerifier implements DocumentStructureVerifier {
  readonly #catalog: DocumentationCatalogReader;
  readonly #profiles: DocumentPlanningProfileReader;

  constructor(dependencies: {
    readonly catalog: DocumentationCatalogReader;
    readonly profiles: DocumentPlanningProfileReader;
  }) {
    this.#catalog = dependencies.catalog;
    this.#profiles = dependencies.profiles;
  }

  async verify(input: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly diagnostics: readonly DocumentStructureDiagnostic[];
    readonly valid: boolean;
  }> {
    const request = {
      consumerRoot: input.consumerRoot,
      profilePath: input.plan.authority.profile.path,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const [catalog, profile] = await Promise.all([
      this.#catalog.execute(request),
      this.#profiles.read({
        consumerRoot: input.consumerRoot,
        path: input.plan.authority.profile.path,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    ]);
    const diagnostics = [...authorityDiagnostics(catalog, input.plan)];
    if (!sameEvidence(profile.evidence, input.plan.authority.profile)) {
      diagnostics.push(diagnostic(
        "document.new.profile-authority-mismatch",
        input.plan.authority.profile.path,
        "The planning profile authority does not match the applied plan.",
      ));
    }
    if (catalog.status !== "complete") {
      diagnostics.push(diagnostic(
        "document.new.catalog-partial",
        input.plan.destination,
        "The post-apply documentation catalog is partial.",
      ));
    }
    const artifact = selectDocumentArtifact(profile, input.plan.intent.type);
    const expectedTitle = artifact.heading.kind === "title"
      ? input.plan.intent.title
      : `${input.plan.intent.id}: ${input.plan.intent.title}`;
    const candidates = catalog.documents.filter((entry) =>
      entry.id === input.plan.intent.id ||
      entry.repositoryPath === input.plan.destination
    );
    if (
      candidates.length !== 1 ||
      !descriptorMatches(
        candidates[0]!,
        input.plan,
        artifact.initialStatus,
        expectedTitle,
      )
    ) {
      diagnostics.push(diagnostic(
        "document.new.descriptor-mismatch",
        input.plan.destination,
        "The rebuilt catalog does not contain exactly the planned document descriptor.",
      ));
    }
    return Object.freeze({
      diagnostics: Object.freeze(diagnostics),
      valid: diagnostics.length === 0,
    });
  }
}
