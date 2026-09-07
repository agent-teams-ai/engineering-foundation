import type { PublicApiArtifactSnapshot, PublicApiSnapshot } from "../model/public-api.js";

/** Reuse the existing release policy without changing the typed baseline wire format. */
export function artifactApiProjection(snapshot: PublicApiArtifactSnapshot): PublicApiSnapshot {
  const schemas = new Map(snapshot.jsonSchemas.map((schema) => [schema.path, schema]));
  return {
    schemaVersion: 1,
    packageName: snapshot.packageName,
    packageVersion: snapshot.packageVersion,
    extractorVersion: "package-artifact-inventory/1",
    entrypoints: snapshot.wildcardExports.map((entry) => ({
      exportPath: entry.exportPath,
      items: [
        {
          canonicalReference: "pattern",
          kind: "WildcardTarget",
          parentKind: "EntryPoint",
          signature: entry.targetPattern
        },
        ...entry.members.map((path) => {
          const schema = schemas.get(path);
          return {
            canonicalReference: `member:${path}`,
            kind: "ArtifactMember",
            parentKind: "EntryPoint",
            // The digest covers discriminator and constraint bytes; descriptive
            // inventory object ordering is not part of the exported contract.
            signature: JSON.stringify({ path, id: schema?.id, digest: schema?.digest })
          };
        })
      ]
    }))
  };
}
