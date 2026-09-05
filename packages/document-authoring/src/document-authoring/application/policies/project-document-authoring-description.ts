import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import { resolvedArtifactOwnerIds } from "../model/validated-document-authoring-profile.js";
import type { DocumentAuthoringProfileDescriptionV2, DocumentAuthoringProfileDescriptionV3, DocumentAuthoringTypeDescriptionV2, DocumentReachabilityStrategyV2 } from "../model/document-authoring-profile-description.js";
import type { DocumentIdentityStrategy, DocumentPlacementStrategy } from "../model/document-planning.js";
import { documentAuthoringProfileSemanticDigest, documentAuthoringProfileSemanticDigestV3 } from "./document-authoring-semantic-digests.js";
import { DocumentCatalogError } from "../model/document-catalog-error.js";
import type { LoadedDescriptionAuthority } from "../model/document-description-authority.js";
const BASE_REQUIRED_METADATA = Object.freeze([
  "id",
  "type",
  "status",
  "owner",
  "summary"
]);

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

export function projectDescription(
  authority: LoadedDescriptionAuthority
): DocumentAuthoringProfileDescriptionV2 | DocumentAuthoringProfileDescriptionV3 {
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
        `Profile v${profile.schemaVersion} artifact type contains an owner absent from the owner catalog: ${artifactType.type}.`
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
  const common = Object.freeze({
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
    projectId: profile.projectId,
    types
  });
  if (profile.schemaVersion === 2) {
    const withoutDigest: Omit<
      DocumentAuthoringProfileDescriptionV2,
      "semanticDigest"
    > = Object.freeze({
      ...common,
      profileSchemaVersion: 2,
      schemaVersion: 2
    });
    return Object.freeze({
      ...withoutDigest,
      semanticDigest: documentAuthoringProfileSemanticDigest(withoutDigest)
    });
  }
  const withoutDigest: Omit<
    DocumentAuthoringProfileDescriptionV3,
    "semanticDigest"
  > = Object.freeze({
    ...common,
    profileSchemaVersion: 3,
    schemaVersion: 3
  });
  return Object.freeze({
    ...withoutDigest,
    semanticDigest: documentAuthoringProfileSemanticDigestV3(withoutDigest)
  });
}

