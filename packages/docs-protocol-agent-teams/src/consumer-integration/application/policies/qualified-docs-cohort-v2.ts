import type {
  QualifiedDocsCohortBindingV2,
  QualifiedDocsPackageCoordinateV2
} from "../../domain/model.js";

type QualifiedDocsCohortV2PackageKey = keyof QualifiedDocsCohortBindingV2["packages"];

export interface QualifiedDocsCohortV2PackageDescriptor {
  readonly key: QualifiedDocsCohortV2PackageKey;
  readonly name: `@agent-teams/${string}`;
  readonly direct: boolean;
}

/** The sole mapping from Cohort v2 keys to public npm package identities. */
export const QUALIFIED_DOCS_COHORT_V2_PACKAGES: readonly QualifiedDocsCohortV2PackageDescriptor[] =
  Object.freeze([
    Object.freeze({
      key: "repositoryMutation",
      name: "@agent-teams/repository-mutation",
      direct: false
    }),
    Object.freeze({
      key: "documentAuthoring",
      name: "@agent-teams/document-authoring",
      direct: false
    }),
    Object.freeze({
      key: "docsProtocol",
      name: "@agent-teams/docs-protocol",
      direct: true
    }),
    Object.freeze({
      key: "docsProtocolAgentTeams",
      name: "@agent-teams/docs-protocol-agent-teams",
      direct: true
    }),
    Object.freeze({
      key: "engineeringFoundation",
      name: "@agent-teams/engineering-foundation",
      direct: true
    })
  ]);

export function qualifiedDocsCohortV2PackageEntries(
  cohort: QualifiedDocsCohortBindingV2
): readonly (QualifiedDocsCohortV2PackageDescriptor & QualifiedDocsPackageCoordinateV2)[] {
  return QUALIFIED_DOCS_COHORT_V2_PACKAGES.map((descriptor) => Object.freeze({
    ...descriptor,
    ...cohort.packages[descriptor.key]
  }));
}

export function qualifiedDocsCohortV2DirectPackageEntries(
  cohort: QualifiedDocsCohortBindingV2
): readonly (QualifiedDocsCohortV2PackageDescriptor & QualifiedDocsPackageCoordinateV2)[] {
  return qualifiedDocsCohortV2PackageEntries(cohort).filter(({ direct }) => direct);
}
