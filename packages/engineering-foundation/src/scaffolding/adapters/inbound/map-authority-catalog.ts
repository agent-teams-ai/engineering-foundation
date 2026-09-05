interface UnresolvedAuthorityScaffoldTarget {
  readonly id: string;
  readonly role: string;
  readonly path: string;
  readonly packageName: string;
  readonly ownerDocumentId: string;
}

interface UnresolvedAuthorityScaffoldTargetCatalog {
  readonly version: 1;
  readonly packages: readonly UnresolvedAuthorityScaffoldTarget[];
}

export function mapAuthorityCatalog(
  value: unknown
): UnresolvedAuthorityScaffoldTargetCatalog {
  const raw = value as {
    readonly version: 1;
    readonly packages: readonly {
      readonly id: string;
      readonly role: string;
      readonly path: string;
      readonly package_name: string;
      readonly owner_document: string;
    }[];
  };
  return Object.freeze({
    version: 1,
    packages: Object.freeze(
      raw.packages.map((entry) =>
        Object.freeze({
          id: entry.id,
          role: entry.role,
          path: entry.path,
          packageName: entry.package_name,
          ownerDocumentId: entry.owner_document
        })
      )
    )
  });
}
