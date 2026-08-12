import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import type {
  MarkdownDocumentObservation,
  MarkdownObservationIssue,
  MarkdownRepositoryObservation
} from "../../../documentation-observation/application/model/markdown-document.js";
import type { MarkdownRepository } from "../../../documentation-observation/application/ports/markdown-repository.js";
import type {
  DocumentAuthorityEvidence,
  DocumentDescriptor,
  DocumentIdentityProjectionEntry,
  DocumentationCatalogDiagnostic,
  DocumentationCatalogSnapshot
} from "../model/document-catalog.js";
import type {
  AuthoringProfileReader,
  CatalogCollection,
  CatalogProfileSnapshot
} from "../ports/authoring-profile-reader.js";
import type {
  MetadataInstanceValidator,
  MetadataSchemaSnapshot
} from "../ports/metadata-instance-validator.js";
import type {
  OwnerMembershipReader,
  OwnerMembershipSnapshot
} from "../ports/owner-membership-reader.js";
import { DocumentCatalogError } from "../../document-catalog-error.js";
import {
  catalogCollisionDiagnostics,
  catalogDiagnostic,
  catalogObservationDiagnostic,
  duplicateIdentityDiagnostics,
  sortCatalogDiagnostics
} from "../policies/document-catalog-diagnostics.js";
import {
  documentTitle,
  inspectDocumentFields
} from "../policies/document-catalog-fields.js";

export interface BuildDocumentationCatalogRequest {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly signal?: AbortSignal;
}

interface CatalogObservation {
  readonly documents: readonly MarkdownDocumentObservation[];
  readonly issues: readonly MarkdownObservationIssue[];
}

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function collectionContainsPath(
  collection: CatalogCollection,
  repositoryPath: string
): boolean {
  if (collection.kind === "markdown-tree") {
    return matchesPrefix(repositoryPath, collection.root);
  }
  return (
    repositoryPath.split("/").at(-1) === "README.md" &&
    collection.roots.some((root) => matchesPrefix(repositoryPath, root))
  );
}

function isCatalogDocumentPath(
  profile: CatalogProfileSnapshot,
  repositoryPath: string
): boolean {
  return profile.collections.some((collection) =>
    collectionContainsPath(collection, repositoryPath)
  );
}

function catalogObservation(
  observation: MarkdownRepositoryObservation,
  profile: CatalogProfileSnapshot
): CatalogObservation {
  const rootIssues = new Set(["root-missing", "root-not-directory"]);
  return {
    documents: observation.documents.filter((document) =>
      isCatalogDocumentPath(profile, document.repositoryPath)
    ),
    issues: observation.issues.filter(
      (issue) =>
        rootIssues.has(issue.kind) ||
        isCatalogDocumentPath(profile, issue.repositoryPath)
    )
  };
}

function sameObservation(
  left: CatalogObservation,
  right: CatalogObservation
): boolean {
  if (
    left.documents.length !== right.documents.length ||
    left.issues.length !== right.issues.length
  ) {
    return false;
  }
  for (const [index, document] of left.documents.entries()) {
    const candidate = right.documents[index];
    if (
      candidate === undefined ||
      document.repositoryPath !== candidate.repositoryPath ||
      document.source !== candidate.source
    ) {
      return false;
    }
  }
  for (const [index, issue] of left.issues.entries()) {
    const candidate = right.issues[index];
    if (
      candidate === undefined ||
      issue.kind !== candidate.kind ||
      issue.message !== candidate.message ||
      issue.repositoryPath !== candidate.repositoryPath
    ) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function assertAuthorityStable(input: {
  readonly metadataAfter: MetadataSchemaSnapshot;
  readonly metadataBefore: MetadataSchemaSnapshot;
  readonly ownersAfter: OwnerMembershipSnapshot;
  readonly ownersBefore: OwnerMembershipSnapshot;
  readonly profileAfter: CatalogProfileSnapshot;
  readonly profileBefore: CatalogProfileSnapshot;
}): void {
  if (
    !sameEvidence(input.metadataBefore.evidence, input.metadataAfter.evidence) ||
    !sameEvidence(input.ownersBefore.evidence, input.ownersAfter.evidence) ||
    !sameEvidence(input.profileBefore.evidence, input.profileAfter.evidence)
  ) {
    throw new DocumentCatalogError(
      "DOCUMENT_CATALOG_AUTHORITY_CHANGED",
      "Document catalog authority changed while the repository was observed."
    );
  }
}

function repositoryRoots(profile: CatalogProfileSnapshot): readonly string[] {
  return Object.freeze(
    [...new Set(
      profile.collections.flatMap((collection) =>
        collection.kind === "markdown-tree" ? [collection.root] : collection.roots
      )
    )].toSorted(compareBinaryStrings)
  );
}

interface CatalogDependencies {
  readonly metadata: MetadataInstanceValidator;
  readonly owners: OwnerMembershipReader;
  readonly profile: AuthoringProfileReader;
  readonly repository: MarkdownRepository;
}

interface LoadedCatalogAuthority {
  readonly metadata: MetadataSchemaSnapshot;
  readonly owners: OwnerMembershipSnapshot;
  readonly profile: CatalogProfileSnapshot;
}

function signalOption(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

async function loadCatalogAuthority(
  dependencies: CatalogDependencies,
  request: BuildDocumentationCatalogRequest
): Promise<LoadedCatalogAuthority> {
  const profile = await dependencies.profile.read({
    consumerRoot: request.consumerRoot,
    path: request.profilePath,
    ...signalOption(request.signal)
  });
  const [owners, metadata] = await Promise.all([
    dependencies.owners.read({
      consumerRoot: request.consumerRoot,
      contract: profile.ownerCatalog.contract,
      path: profile.ownerCatalog.path,
      ...signalOption(request.signal)
    }),
    dependencies.metadata.load({
      consumerRoot: request.consumerRoot,
      path: profile.metadataSchemaPath,
      ...signalOption(request.signal)
    })
  ]);
  return { metadata, owners, profile };
}

async function observeCatalogTwice(
  repository: MarkdownRepository,
  authority: LoadedCatalogAuthority,
  request: BuildDocumentationCatalogRequest
): Promise<readonly [CatalogObservation, CatalogObservation]> {
  const observationRequest = {
    consumerRoot: request.consumerRoot,
    excludedPrefixes: authority.profile.excludedPrefixes,
    roots: repositoryRoots(authority.profile),
    ...signalOption(request.signal)
  };
  const first = catalogObservation(
    await repository.observe(observationRequest),
    authority.profile
  );
  const second = catalogObservation(
    await repository.observe(observationRequest),
    authority.profile
  );
  return [first, second];
}

async function assertAuthorityRemainedStable(
  dependencies: CatalogDependencies,
  request: BuildDocumentationCatalogRequest,
  before: LoadedCatalogAuthority
): Promise<void> {
  let after: LoadedCatalogAuthority;
  try {
    after = await loadCatalogAuthority(dependencies, request);
  } catch (error) {
    if (error instanceof DocumentCatalogError) {
      throw new DocumentCatalogError(
        "DOCUMENT_CATALOG_AUTHORITY_CHANGED",
        "Document catalog authority became unavailable while the repository was observed.",
        { cause: error }
      );
    }
    throw error;
  }
  assertAuthorityStable({
    metadataAfter: after.metadata,
    metadataBefore: before.metadata,
    ownersAfter: after.owners,
    ownersBefore: before.owners,
    profileAfter: after.profile,
    profileBefore: before.profile
  });
}

interface InspectedCatalogDocument {
  readonly descriptor?: DocumentDescriptor;
  readonly diagnostic?: DocumentationCatalogDiagnostic;
  readonly identity?: DocumentIdentityProjectionEntry;
}

function inspectCatalogDocument(
  document: MarkdownDocumentObservation,
  metadata: MetadataSchemaSnapshot,
  ownerIds: ReadonlySet<string>
): InspectedCatalogDocument {
  if (document.source.startsWith("\uFEFF") || document.source.includes("\u0000")) {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.source-invalid",
        document.repositoryPath,
        "Catalog Markdown must not contain a UTF-8 BOM or NUL characters."
      )
    };
  }
  if (document.frontmatter.kind === "absent") {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.frontmatter-required",
        document.repositoryPath,
        "Catalog documents must contain strict YAML frontmatter."
      )
    };
  }
  if (document.frontmatter.kind === "invalid") {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.frontmatter-invalid",
        document.repositoryPath,
        document.frontmatter.message
      )
    };
  }
  if (!isRecord(document.frontmatter.value)) {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.frontmatter-invalid",
        document.repositoryPath,
        "Document frontmatter must be an object."
      )
    };
  }
  const fieldInspection = inspectDocumentFields(
    document,
    document.frontmatter.value
  );
  if (fieldInspection.fields === undefined) {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.descriptor-invalid",
        document.repositoryPath,
        "Document metadata must provide bounded id, type, status, owner, and summary strings."
      ),
      ...(fieldInspection.identity === undefined
        ? {}
        : { identity: fieldInspection.identity })
    };
  }
  const { fields, identity } = fieldInspection;
  const validation = metadata.validate(document.frontmatter.value);
  if (!validation.valid) {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.metadata-invalid",
        document.repositoryPath,
        validation.messages.join("; ") || "Document metadata is invalid."
      ),
      identity
    };
  }
  if (!ownerIds.has(fields.owner)) {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.owner-unknown",
        document.repositoryPath,
        `Document owner is absent from the owner catalog: ${fields.owner}.`
      ),
      identity
    };
  }
  const title = documentTitle(document);
  if (title === undefined) {
    return {
      diagnostic: catalogDiagnostic(
        "document.catalog.title-invalid",
        document.repositoryPath,
        "Catalog documents must contain a bounded level-one heading."
      ),
      identity
    };
  }
  return {
    descriptor: Object.freeze({
      ...fields,
      repositoryPath: document.repositoryPath,
      source: document.source,
      title
    }),
    identity
  };
}

function createCatalogSnapshot(
  authority: LoadedCatalogAuthority,
  first: CatalogObservation,
  second: CatalogObservation
): DocumentationCatalogSnapshot {
  const diagnostics: DocumentationCatalogDiagnostic[] = second.issues.map(
    catalogObservationDiagnostic
  );
  if (!sameObservation(first, second)) {
    diagnostics.push(
      catalogDiagnostic(
        "document.catalog.corpus-changed",
        authority.profile.projectId,
        "Documentation corpus changed between stable observation passes."
      )
    );
  }
  const documents: DocumentDescriptor[] = [];
  const identityProjection: DocumentIdentityProjectionEntry[] = [];
  const ownerIds = new Set(authority.owners.ids);
  for (const document of second.documents) {
    const inspected = inspectCatalogDocument(document, authority.metadata, ownerIds);
    if (inspected.descriptor !== undefined) {
      documents.push(inspected.descriptor);
    }
    if (inspected.identity !== undefined) {
      identityProjection.push(inspected.identity);
    }
    if (inspected.diagnostic !== undefined) {
      diagnostics.push(inspected.diagnostic);
    }
  }
  const sortedIdentity = identityProjection.toSorted(
    (left, right) =>
      compareBinaryStrings(left.id, right.id) ||
      compareBinaryStrings(left.repositoryPath, right.repositoryPath)
  );
  diagnostics.push(...duplicateIdentityDiagnostics(sortedIdentity));
  diagnostics.push(
    ...catalogCollisionDiagnostics(
      second.documents.map((document) => document.repositoryPath)
    )
  );
  const sortedDiagnostics = sortCatalogDiagnostics(diagnostics);
  return Object.freeze({
    authority: Object.freeze({
      metadataSchema: authority.metadata.evidence,
      ownerCatalog: authority.owners.evidence,
      profile: authority.profile.evidence
    }),
    diagnostics: Object.freeze(sortedDiagnostics),
    documents: Object.freeze(
      documents.toSorted((left, right) =>
        compareBinaryStrings(left.repositoryPath, right.repositoryPath)
      )
    ),
    identityProjection: Object.freeze(sortedIdentity),
    ownerIds: Object.freeze([...authority.owners.ids]),
    projectId: authority.profile.projectId,
    status: sortedDiagnostics.length === 0 ? "complete" : "partial"
  });
}

export class BuildDocumentationCatalog {
  readonly #metadata: MetadataInstanceValidator;
  readonly #owners: OwnerMembershipReader;
  readonly #profile: AuthoringProfileReader;
  readonly #repository: MarkdownRepository;

  constructor(dependencies: {
    readonly metadata: MetadataInstanceValidator;
    readonly owners: OwnerMembershipReader;
    readonly profile: AuthoringProfileReader;
    readonly repository: MarkdownRepository;
  }) {
    this.#metadata = dependencies.metadata;
    this.#owners = dependencies.owners;
    this.#profile = dependencies.profile;
    this.#repository = dependencies.repository;
  }

  async execute(
    request: BuildDocumentationCatalogRequest
  ): Promise<DocumentationCatalogSnapshot> {
    const dependencies = {
      metadata: this.#metadata,
      owners: this.#owners,
      profile: this.#profile,
      repository: this.#repository
    };
    const authority = await loadCatalogAuthority(dependencies, request);
    const [first, second] = await observeCatalogTwice(
      this.#repository,
      authority,
      request
    );
    await assertAuthorityRemainedStable(dependencies, request, authority);
    return createCatalogSnapshot(authority, first, second);
  }
}
