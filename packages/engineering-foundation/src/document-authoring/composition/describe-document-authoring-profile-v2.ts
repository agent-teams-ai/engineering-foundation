import { compareBinaryStrings } from "../../binary-string-comparator.js";
import { assertNotCancelled } from "../../cancellation.js";
import { NodeDocumentMetadataSidecarReader } from "../adapters/node/node-document-metadata-sidecar-reader.js";
import {
  loadValidatedDocumentAuthoringProfileV2,
  resolvedArtifactOwnerIds,
  type ValidatedDocumentAuthoringProfileV2
} from "../adapters/node/load-validated-document-authoring-profile-v2.js";
import { NodeMetadataInstanceValidator } from "../adapters/node/node-metadata-instance-validator.js";
import { NodeOwnerMembershipReader } from "../adapters/node/node-owner-membership-reader.js";
import { readDocumentAuthorityFile } from "../adapters/node/read-document-authority-file.js";
import type {
  DocumentAuthoringProfileDescriptionV2,
  DocumentAuthoringTypeDescriptionV2,
  DocumentReachabilityStrategyV2
} from "../application/model/document-authoring-profile-description.js";
import type { DocumentAuthorityEvidence } from "../application/model/document-catalog.js";
import type {
  DocumentIdentityStrategy,
  DocumentPlacementStrategy
} from "../application/model/document-planning.js";
import { documentAuthoringProfileSemanticDigest } from "../application/policies/document-authoring-semantic-digests.js";
import type { MetadataSchemaSnapshot } from "../application/ports/metadata-instance-validator.js";
import type { OwnerMembershipSnapshot } from "../application/ports/owner-membership-reader.js";
import { DocumentCatalogError } from "../document-catalog-error.js";

const MAX_TEMPLATE_BYTES = 256 * 1024;
const BASE_REQUIRED_METADATA = Object.freeze([
  "id",
  "type",
  "status",
  "owner",
  "summary"
]);

export interface DescribeDocumentAuthoringProfileV2Request {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly signal?: AbortSignal;
}

interface LoadedDescriptionAuthority {
  readonly metadata: MetadataSchemaSnapshot;
  readonly ownerCatalog: OwnerMembershipSnapshot;
  readonly profile: ValidatedDocumentAuthoringProfileV2;
  readonly profileEvidence: DocumentAuthorityEvidence;
  readonly sidecarEvidence?: DocumentAuthorityEvidence;
  readonly templateEvidenceByPath: ReadonlyMap<string, DocumentAuthorityEvidence>;
}

function freezeIdentity(identity: DocumentIdentityStrategy): DocumentIdentityStrategy {
  return identity.format === "qualified"
    ? Object.freeze({
        ...identity,
        grammar: Object.freeze({
          ...identity.grammar,
          prefixSegments: Object.freeze([...identity.grammar.prefixSegments])
        })
      })
    : Object.freeze({ ...identity });
}

function freezePlacement(placement: DocumentPlacementStrategy): DocumentPlacementStrategy {
  return placement.kind === "explicit"
    ? Object.freeze({
        ...placement,
        allowedRoots: Object.freeze([...placement.allowedRoots]),
        requiredSegmentsInOrder: Object.freeze([
          ...placement.requiredSegmentsInOrder
        ])
      })
    : Object.freeze({ ...placement });
}

function freezeReachability(value: unknown): DocumentReachabilityStrategyV2 {
  return Object.freeze({
    ...(value as Record<string, unknown>)
  }) as unknown as DocumentReachabilityStrategyV2;
}

function describeType(
  artifactType: Record<string, unknown>,
  allowedOwnerIds: readonly string[],
  requiredMetadata: readonly string[]
): DocumentAuthoringTypeDescriptionV2 {
  return Object.freeze({
    allowedOwnerIds: Object.freeze(
      [...allowedOwnerIds].toSorted(
        compareBinaryStrings
      )
    ),
    heading: Object.freeze({
      ...(artifactType["heading"] as { kind: "id-colon-title" | "title" })
    }),
    identity: freezeIdentity(
      artifactType["identity"] as DocumentIdentityStrategy
    ),
    initialStatus: artifactType["initialStatus"] as string,
    placement: freezePlacement(
      artifactType["placement"] as DocumentPlacementStrategy
    ),
    reachability: freezeReachability(artifactType["reachability"]),
    requiredMetadata,
    template: Object.freeze({
      ...(artifactType["template"] as {
        kind: "fenced-markdown-body";
        path: string;
      })
    }),
    type: artifactType["type"] as string
  });
}

async function loadTemplateEvidence(
  request: DescribeDocumentAuthoringProfileV2Request,
  profile: ValidatedDocumentAuthoringProfileV2
): Promise<ReadonlyMap<string, DocumentAuthorityEvidence>> {
  const paths = [...new Set(
    profile.authoring.artifactTypes.map((artifactType) => artifactType.template.path)
  )].toSorted(compareBinaryStrings);
  const files = await Promise.all(
    paths.map((path) =>
      readDocumentAuthorityFile({
        consumerRoot: request.consumerRoot,
        maxBytes: MAX_TEMPLATE_BYTES,
        path
      })
    )
  );
  assertNotCancelled(request.signal);
  return new Map(files.map((file) => [file.evidence.path, file.evidence]));
}

async function loadDescriptionAuthority(
  request: DescribeDocumentAuthoringProfileV2Request
): Promise<LoadedDescriptionAuthority> {
  const { evidence, profile } = await loadValidatedDocumentAuthoringProfileV2({
    consumerRoot: request.consumerRoot,
    path: request.profilePath,
    ...(request.signal === undefined ? {} : { signal: request.signal })
  });
  if (profile.schemaVersion !== 2 && profile.schemaVersion !== 3) {
    throw new DocumentCatalogError(
      "DOCUMENT_CATALOG_INPUT_INVALID",
      "Document authoring profile description requires schemaVersion 2 or 3."
    );
  }
  const [ownerCatalog, metadata, sidecar, templateEvidenceByPath] =
    await Promise.all([
      new NodeOwnerMembershipReader().read({
        consumerRoot: request.consumerRoot,
        contract: profile.catalog.ownerCatalog.contract,
        path: profile.catalog.ownerCatalog.path,
        ...(request.signal === undefined ? {} : { signal: request.signal })
      }),
      new NodeMetadataInstanceValidator().load({
        consumerRoot: request.consumerRoot,
        path: profile.catalog.metadataSchemaPath,
        ...(request.signal === undefined ? {} : { signal: request.signal })
      }),
      profile.catalog.metadataSidecar === undefined
        ? undefined
        : new NodeDocumentMetadataSidecarReader().read({
            consumerRoot: request.consumerRoot,
            path: profile.catalog.metadataSidecar.path,
            ...(request.signal === undefined ? {} : { signal: request.signal })
          }),
      loadTemplateEvidence(request, profile)
    ]);
  return Object.freeze({
    metadata,
    ownerCatalog,
    profile,
    profileEvidence: evidence,
    ...(sidecar === undefined ? {} : { sidecarEvidence: sidecar.evidence }),
    templateEvidenceByPath
  });
}

function projectDescription(
  authority: LoadedDescriptionAuthority
): DocumentAuthoringProfileDescriptionV2 {
  const { metadata, ownerCatalog, profile, profileEvidence } = authority;
  const ownerIds = Object.freeze(
    [...ownerCatalog.ids].toSorted(compareBinaryStrings)
  );
  const ownerSet = new Set(ownerIds);
  for (const artifactType of profile.authoring.artifactTypes) {
    const allowedOwnerIds = resolvedArtifactOwnerIds(profile, artifactType);
    if (allowedOwnerIds === undefined) {
      throw new DocumentCatalogError(
        "DOCUMENT_CATALOG_INPUT_INVALID",
        `Profile v${profile.schemaVersion} artifact type does not declare authoring owners: ${artifactType.type}.`
      );
    }
    if (allowedOwnerIds.some((owner) => !ownerSet.has(owner))) {
      throw new DocumentCatalogError(
        "DOCUMENT_CATALOG_INPUT_INVALID",
        `Profile v2 artifact type contains an owner absent from the owner catalog: ${artifactType.type}.`
      );
    }
  }
  const requiredMetadata = Object.freeze(
    [...new Set([
      ...BASE_REQUIRED_METADATA,
      ...(metadata.requiredProperties ?? [])
    ])].toSorted(compareBinaryStrings)
  );
  const types = Object.freeze(
    profile.authoring.artifactTypes
      .map((artifactType) => {
        const allowedOwnerIds = resolvedArtifactOwnerIds(profile, artifactType);
        if (allowedOwnerIds === undefined) {
          throw new DocumentCatalogError(
            "DOCUMENT_CATALOG_INPUT_INVALID",
            `Profile v${profile.schemaVersion} artifact type does not declare authoring owners: ${artifactType.type}.`
          );
        }
        return describeType(artifactType, allowedOwnerIds, requiredMetadata);
      })
      .toSorted((left, right) => compareBinaryStrings(left.type, right.type))
  );
  const templates = Object.freeze(
    types.map((type) => {
      const evidence = authority.templateEvidenceByPath.get(type.template.path);
      if (evidence === undefined) {
        throw new DocumentCatalogError(
          "DOCUMENT_CATALOG_AUTHORITY_UNAVAILABLE",
          `Document template evidence is unavailable: ${type.template.path}.`
        );
      }
      return Object.freeze({ evidence, type: type.type });
    })
  );
  const withoutDigest: Omit<
    DocumentAuthoringProfileDescriptionV2,
    "semanticDigest"
  > = Object.freeze({
    authority: Object.freeze({
      metadataSchema: metadata.evidence,
      ...(authority.sidecarEvidence === undefined
        ? {}
        : { metadataSidecar: authority.sidecarEvidence }),
      ownerCatalog: ownerCatalog.evidence,
      profile: profileEvidence,
      templates
    }),
    authorityPaths: Object.freeze({
      metadataSchema: metadata.evidence.path,
      ...(authority.sidecarEvidence === undefined
        ? {}
        : { metadataSidecar: authority.sidecarEvidence.path }),
      ownerCatalog: ownerCatalog.evidence.path,
      profile: profileEvidence.path
    }),
    catalog: Object.freeze({
      collections: Object.freeze(
        profile.catalog.collections
          .map((collection) =>
            Object.freeze(
              collection.kind === "frontmatter-readme"
                ? {
                    ...collection,
                    roots: Object.freeze(
                      [...collection.roots].toSorted(compareBinaryStrings)
                    )
                  }
                : { ...collection }
            )
          )
          .toSorted((left, right) =>
            compareBinaryStrings(
              left.kind === "markdown-tree" ? left.root : left.roots.join("/"),
              right.kind === "markdown-tree" ? right.root : right.roots.join("/")
            )
          )
      ),
      excludedPrefixes: Object.freeze(
        [...(profile.catalog.excludedPrefixes ?? [])].toSorted(compareBinaryStrings)
      )
    }),
    ownerIds,
    profileSchemaVersion: profile.schemaVersion as 2 | 3,
    projectId: profile.projectId,
    schemaVersion: 2,
    types
  });
  return Object.freeze({
    ...withoutDigest,
    semanticDigest: documentAuthoringProfileSemanticDigest(withoutDigest)
  });
}

export async function describeDocumentAuthoringProfileV2(
  request: DescribeDocumentAuthoringProfileV2Request
): Promise<DocumentAuthoringProfileDescriptionV2> {
  const before = projectDescription(await loadDescriptionAuthority(request));
  const after = projectDescription(await loadDescriptionAuthority(request));
  if (before.semanticDigest !== after.semanticDigest) {
    throw new DocumentCatalogError(
      "DOCUMENT_CATALOG_AUTHORITY_CHANGED",
      "Document authoring profile authority changed while it was described."
    );
  }
  return after;
}
