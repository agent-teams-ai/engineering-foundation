import { compareCanonicalReferences, type PublicApiSnapshot } from "../model/public-api.js";
import {
  auditIdentityKey, PUBLIC_API_AUDIT_PROFILE,
  type AuditDeclaration, type AuditIdentity, type AuditObservation
} from "../model/public-api-observation.js";

/** Subject remains part of resolution identity, but is removed from comparison coordinates. */
function coordinate(identity: AuditIdentity): readonly string[] {
  return [identity.packageName, identity.exportPath, identity.canonicalReference];
}
function record(item: AuditDeclaration) {
  return {
    identity: coordinate(item.identity), kind: item.kind,
    parentReference: item.parentReference, parentKind: item.parentKind,
    excerpt: item.excerpt, isExported: item.isExported, public: item.public,
    references: item.references.map((reference) => ({
      text: reference.text, canonicalReference: reference.canonicalReference,
      resolution: reference.resolution,
      ...(reference.target === undefined ? {} : { target: coordinate(reference.target) }),
      ...(reference.library === undefined ? {} : { library: reference.library })
    }))
  };
}
export interface AuditGraphProjection {
  readonly snapshot: PublicApiSnapshot;
  readonly graphs: readonly {
    readonly root: AuditIdentity;
    readonly signature: string;
    readonly nodes: readonly ReturnType<typeof record>[];
  }[];
}

/** Finite declaration/reference closure, not TypeScript assignability. */
export function projectPublicApiObservation(
  observations: readonly AuditObservation[], packageName: string
): AuditGraphProjection {
  const subject = observations[0]?.subject;
  const index = new Map<string, AuditDeclaration>();
  for (const observation of observations) {
    if (observation.subject !== subject) {throw new Error("Mixed audit subjects.");}
    for (const item of observation.items) {
      if (item.identity.subject !== subject || item.identity.packageName !== observation.packageName ||
          item.identity.exportPath !== observation.exportPath) {throw new Error("Invalid scoped identity.");}
      const key = auditIdentityKey(item.identity);
      if (index.has(key)) {throw new Error(`Duplicate audit identity: ${key}.`);}
      index.set(key, item);
    }
  }
  let visitedRecords = 0;
  let signatureCharacters = 0;
  const graphs: AuditGraphProjection["graphs"][number][] = [];
  const packages = observations.filter((observation) => observation.packageName === packageName)
    .toSorted((a, b) => compareCanonicalReferences(a.exportPath ?? "", b.exportPath ?? ""));
  if (packages.length === 0) {throw new Error("Missing audit package.");}
  if (new Set(packages.map((entry) => entry.exportPath)).size !== packages.length) {throw new Error("Duplicate export path.");}
  const entrypoints = packages.flatMap((observation) => observation.exportPath === null ? [] : [{
    exportPath: observation.exportPath,
    items: observation.items.filter((item) => item.public)
      .toSorted((a, b) => compareCanonicalReferences(a.identity.canonicalReference, b.identity.canonicalReference))
      .map((root) => {
        const visited = new Set<string>();
        const pending = [root];
        const nodes: ReturnType<typeof record>[] = [];
        while (pending.length > 0) {
          const item = pending.pop();
          if (item === undefined) {break;}
          const key = auditIdentityKey(item.identity);
          if (visited.has(key)) {continue;}
          visited.add(key);
          if (++visitedRecords > 20_000) {throw new Error("Audit reachable graph budget exhausted.");}
          nodes.push(record(item));
          for (const reference of item.references) {
            if (reference.resolution === "verified-external-library" && reference.library !== undefined) {continue;}
            if (reference.resolution !== "local" && reference.resolution !== "same-subject-dependency") {throw new Error("Unresolved required reference.");}
            const target = reference.target === undefined ? undefined : index.get(auditIdentityKey(reference.target));
            if (target === undefined) {throw new Error("Missing scoped reference target.");}
            pending.push(target);
          }
          // Referenced interfaces/classes/namespaces carry their declaration members.
          for (const member of index.values()) {
            if (member.identity.packageName === item.identity.packageName &&
                member.identity.exportPath === item.identity.exportPath &&
                member.parentReference === item.identity.canonicalReference) {pending.push(member);}
          }
        }
        const sortedNodes = nodes.toSorted((a, b) => compareCanonicalReferences(JSON.stringify(a.identity), JSON.stringify(b.identity)));
        const signature = JSON.stringify({ domain: PUBLIC_API_AUDIT_PROFILE, nodes: sortedNodes });
        signatureCharacters += signature.length;
        if (signatureCharacters > 16 * 1024 * 1024) {throw new Error("Audit projection byte budget exhausted.");}
        graphs.push({ root: root.identity, signature, nodes: sortedNodes });
        return { canonicalReference: root.identity.canonicalReference, kind: root.kind,
          parentReference: root.parentReference, parentKind: root.parentKind, signature };
      })
  }]);
  return { snapshot: { schemaVersion: 1, packageName,
    packageVersion: packages[0]?.packageVersion ?? "", extractorVersion: packages[0]?.toolchain ?? "",
    entrypoints }, graphs };
}
