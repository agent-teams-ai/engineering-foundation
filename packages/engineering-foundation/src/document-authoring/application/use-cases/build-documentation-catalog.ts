import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import {
  type MarkdownDocumentObservation,
  type MarkdownObservationIssue,
  type MarkdownRepositoryObservation
} from "../../../documentation-observation/application/model/markdown-document.js";
import type { MarkdownRepository } from "../../../documentation-observation/application/ports/markdown-repository.js";
import type { DocumentDescriptor, DocumentIdentityProjectionEntry, DocumentationCatalogDiagnostic, DocumentationCatalogSnapshot, DocumentationCatalogSnapshotV2, DocumentationSearchCatalogSnapshot, DocumentationSearchCatalogSnapshotV2, DocumentSearchCorpusEntry } from "../model/document-catalog.js";
import type { DocumentationCatalogReadRequest, DocumentationSearchCatalogReader } from "../ports/documentation-search-catalog-reader.js";
import type { DocumentationCatalogReader } from "../ports/documentation-catalog-reader.js";
import type { DocumentationCatalogReaderV2 } from "../ports/documentation-catalog-reader-v2.js";
import type { DocumentationSearchCatalogReaderV2 } from "../ports/documentation-search-catalog-reader-v2.js";
import type {
  DocumentMetadataSidecarReader,
  DocumentMetadataSidecarSnapshot
} from "../ports/document-metadata-sidecar-reader.js";
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
  inspectCatalogDocument
} from "../policies/inspect-catalog-document.js";
import {
  assertSidecarDocumentPaths,
  inspectCatalogDocumentWithSidecar,
  orphanSidecarDiagnostics
} from "../policies/document-catalog-sidecar.js";
import { assertCatalogAuthorityStable } from "../policies/document-catalog-authority-stability.js";
import { documentationCatalogSemanticDigest } from "../policies/document-authoring-semantic-digests.js";

export interface BuildDocumentationCatalogRequest {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly signal?: AbortSignal;
}
interface CatalogObservation { readonly documents: readonly MarkdownDocumentObservation[]; readonly issues: readonly MarkdownObservationIssue[]; }

const matchesPrefix = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

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

function catalogDocumentSource(
  profile: CatalogProfileSnapshot,
  repositoryPath: string
): DocumentDescriptor["source"] {
  return profile.collections.some(
    (collection) =>
      collection.kind === "frontmatter-readme" &&
      collectionContainsPath(collection, repositoryPath)
  )
    ? "frontmatter-readme"
    : "markdown-tree";
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
  readonly sidecar?: DocumentMetadataSidecarReader;
}

interface LoadedCatalogAuthority {
  readonly metadata: MetadataSchemaSnapshot;
  readonly owners: OwnerMembershipSnapshot;
  readonly profile: CatalogProfileSnapshot;
  readonly sidecar?: DocumentMetadataSidecarSnapshot;
}

function signalOption(signal: AbortSignal | undefined): {
  readonly signal?: AbortSignal;
} {
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
  const knownOwnerIds = new Set(owners.ids);
  for (const artifact of profile.artifactOwnerIds ?? []) {
    const unknownOwner = artifact.ids.find((owner) => !knownOwnerIds.has(owner));
    if (unknownOwner !== undefined) {
      throw new DocumentCatalogError(
        "DOCUMENT_CATALOG_INPUT_INVALID",
        `Profile v${profile.schemaVersion ?? 2} artifact type ${artifact.type} allows an owner absent from the owner catalog: ${unknownOwner}.`
      );
    }
  }
  let sidecar: DocumentMetadataSidecarSnapshot | undefined;
  if (profile.metadataSidecar !== undefined) {
    if (dependencies.sidecar === undefined) {
      throw new DocumentCatalogError(
        "DOCUMENT_CATALOG_INPUT_INVALID",
        "Document metadata sidecar authority requires a sidecar reader."
      );
    }
    sidecar = await dependencies.sidecar.read({
      consumerRoot: request.consumerRoot,
      path: profile.metadataSidecar.path,
      ...signalOption(request.signal)
    });
    assertSidecarDocumentPaths(profile, sidecar);
  }
  return {
    metadata,
    owners,
    profile,
    ...(sidecar === undefined ? {} : { sidecar })
  };
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
  assertCatalogAuthorityStable(before, after);
}

interface CatalogDocumentInspection<
  Descriptor extends DocumentDescriptor,
  SearchEntry extends DocumentSearchCorpusEntry
> {
  readonly descriptor?: Descriptor;
  readonly diagnostic?: DocumentationCatalogDiagnostic;
  readonly identity?: DocumentIdentityProjectionEntry;
  readonly searchEntry?: SearchEntry;
}

type CatalogSnapshotFor<Descriptor extends DocumentDescriptor> = Omit<
  DocumentationCatalogSnapshot,
  "documents"
> & { readonly documents: readonly Descriptor[] };

interface SearchCatalogSnapshotFor<
  Descriptor extends DocumentDescriptor,
  SearchEntry extends DocumentSearchCorpusEntry
> {
  readonly catalog: CatalogSnapshotFor<Descriptor>;
  readonly documents: readonly SearchEntry[];
}

function createCatalogSnapshot<
  Descriptor extends DocumentDescriptor,
  SearchEntry extends DocumentSearchCorpusEntry
>(
  authority: LoadedCatalogAuthority,
  first: CatalogObservation,
  second: CatalogObservation,
  inspector: (
    document: MarkdownDocumentObservation,
    metadata: MetadataSchemaSnapshot,
    ownerIds: ReadonlySet<string>,
    source: DocumentDescriptor["source"]
  ) => CatalogDocumentInspection<Descriptor, SearchEntry>,
  initialDiagnostics: readonly DocumentationCatalogDiagnostic[] = []
): SearchCatalogSnapshotFor<Descriptor, SearchEntry> {
  const diagnostics: DocumentationCatalogDiagnostic[] = [
    ...initialDiagnostics,
    ...second.issues.map(catalogObservationDiagnostic)
  ];
  if (!sameObservation(first, second)) {
    diagnostics.push(
      catalogDiagnostic(
        "document.catalog.corpus-changed",
        authority.profile.projectId,
        "Documentation corpus changed between stable observation passes."
      )
    );
  }
  const documents: Descriptor[] = [];
  const searchDocuments: SearchEntry[] = [];
  const identityProjection: DocumentIdentityProjectionEntry[] = [];
  const ownerIds = new Set(authority.owners.ids);
  for (const document of second.documents) {
    const inspected = inspector(
      document,
      authority.metadata,
      ownerIds,
      catalogDocumentSource(authority.profile, document.repositoryPath)
    );
    if (inspected.descriptor !== undefined) {
      documents.push(inspected.descriptor);
    }
    if (inspected.searchEntry !== undefined) {
      searchDocuments.push(inspected.searchEntry);
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
      [...new Set([
        ...second.documents.map((document) => document.repositoryPath),
        ...second.issues
          .filter((issue) => !["root-missing", "root-not-directory"].includes(issue.kind))
          .map((issue) => issue.repositoryPath)
      ])]
    )
  );
  const sortedDiagnostics = sortCatalogDiagnostics(diagnostics);
  const catalog: CatalogSnapshotFor<Descriptor> = Object.freeze({
    authority: Object.freeze({
      metadataSchema: authority.metadata.evidence,
      ownerCatalog: authority.owners.evidence,
      profile: authority.profile.evidence,
      ...(authority.sidecar === undefined
        ? {}
        : { metadataSidecar: authority.sidecar.evidence })
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
  return Object.freeze({
    catalog,
    documents: Object.freeze(
      searchDocuments.toSorted((left, right) =>
        compareBinaryStrings(
          left.descriptor.repositoryPath,
          right.descriptor.repositoryPath
        )
      )
    )
  });
}

export class BuildDocumentationCatalog
  implements DocumentationCatalogReader, DocumentationSearchCatalogReader
{
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

  async execute(request: BuildDocumentationCatalogRequest): Promise<DocumentationCatalogSnapshot> {
    return (await this.read(request)).catalog;
  }

  async read(request: DocumentationCatalogReadRequest): Promise<DocumentationSearchCatalogSnapshot> {
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
    return createCatalogSnapshot(authority, first, second, inspectCatalogDocument);
  }
}

export class BuildDocumentationCatalogV2
  implements DocumentationCatalogReaderV2, DocumentationSearchCatalogReaderV2
{
  readonly #metadata: MetadataInstanceValidator;
  readonly #owners: OwnerMembershipReader;
  readonly #profile: AuthoringProfileReader;
  readonly #repository: MarkdownRepository;
  readonly #sidecar: DocumentMetadataSidecarReader | undefined;

  constructor(dependencies: CatalogDependencies) {
    this.#metadata = dependencies.metadata;
    this.#owners = dependencies.owners;
    this.#profile = dependencies.profile;
    this.#repository = dependencies.repository;
    this.#sidecar = dependencies.sidecar;
  }

  async execute(
    request: BuildDocumentationCatalogRequest
  ): Promise<DocumentationCatalogSnapshotV2> {
    return (await this.read(request)).catalog;
  }

  async read(
    request: DocumentationCatalogReadRequest
  ): Promise<DocumentationSearchCatalogSnapshotV2> {
    const dependencies = {
      metadata: this.#metadata,
      owners: this.#owners,
      profile: this.#profile,
      repository: this.#repository,
      ...(this.#sidecar === undefined ? {} : { sidecar: this.#sidecar })
    };
    const authority = await loadCatalogAuthority(dependencies, request);
    if (authority.profile.schemaVersion !== 2 && authority.profile.schemaVersion !== 3) {
      throw new DocumentCatalogError(
        "DOCUMENT_CATALOG_INPUT_INVALID",
        "Documentation Catalog v2 requires document authoring profile schemaVersion 2 or 3."
      );
    }
    const [first, second] = await observeCatalogTwice(
      this.#repository,
      authority,
      request
    );
    await assertAuthorityRemainedStable(dependencies, request, authority);
    const snapshot = createCatalogSnapshot(
      authority,
      first,
      second,
      (document, metadata, ownerIds, source) =>
        inspectCatalogDocumentWithSidecar(
          authority.sidecar,
          document,
          metadata,
          ownerIds,
          source
        ),
      orphanSidecarDiagnostics(authority.sidecar, second.documents)
    );
    const catalog: DocumentationCatalogSnapshotV2 = Object.freeze({
      ...snapshot.catalog,
      semanticDigest: documentationCatalogSemanticDigest(snapshot.catalog)
    });
    return Object.freeze({
      catalog,
      documents: snapshot.documents
    });
  }
}
