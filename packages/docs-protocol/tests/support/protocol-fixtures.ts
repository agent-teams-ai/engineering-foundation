import type { DocsNewRequest } from "../../dist/features/portable-documentation/application/model.js";
export function tenantIntent(): DocsNewRequest["intent"] {
  return {
    type: "adr",
    id: "ADR-0083",
    title: "Tenant isolation",
    owner: "architecture/tooling",
    summary: "Defines tenant isolation.",
  };
}

interface TypeFixture {
  readonly type: string;
  readonly initialStatus: string;
}
interface DescriptorFixture {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly repositoryPath: string;
}
export function authorityRaceFixtures(
  types: readonly TypeFixture[],
  descriptor: (overrides: DescriptorFixture) => DescriptorFixture,
) {
  const initialDescription = {
    authority: { templates: [] },
    projectId: "fixture-project",
    profileSchemaVersion: 3,
    semanticDigest: `sha256:${"6".repeat(64)}`,
    metadataSchemaPath: "docs/metadata.schema.json",
    metadataSidecar: { kind: "none" },
    ownerIds: ["architecture/tooling"],
    types,
    authorityPaths: [],
  };
  const changedDescription = {
    ...initialDescription,
    semanticDigest: `sha256:${"8".repeat(64)}`,
    types: [
      {
        ...types[0],
        initialStatus: "accepted",
        reachability: { kind: "not-required", reason: "changed" },
      },
    ],
  };
  const baseCatalog = {
    projectId: "fixture-project",
    status: "complete",
    diagnostics: [],
    documents: [
      {
        ...descriptor({
          id: "OD-001",
          type: "open-decision",
          status: "open",
          repositoryPath: "docs/open-decisions/OD-001.md",
        }),
        metadata: {},
      },
    ],
    identityProjection: [],
    ownerIds: ["architecture/tooling"],
    authority: {},
    semanticDigest: `sha256:${"7".repeat(64)}`,
  };
  const changedCatalog = {
    ...baseCatalog,
    semanticDigest: `sha256:${"9".repeat(64)}`,
    documents: [{ ...baseCatalog.documents[0], status: "resolved" }],
  };
  return { initialDescription, changedDescription, baseCatalog, changedCatalog };
}

export function recoveryReceipt() {
  const receipt = {
    schemaVersion: 2,
    protocolVersion: 2,
    planDigest: `sha256:${"3".repeat(64)}`,
    adapter: { id: "foundation.filesystem/v1", contractVersion: 1 },
    destination: "docs/decisions/0083-tenant-isolation.md",
    outcome: "recovery-required",
    commit: {
      state: "recovery-required",
      publication: "published",
      fileAtomicity: "single-file-atomic-create",
      recoverability: "preserved-for-recovery",
    },
    directoryMaterialization: {
      state: "created-and-retained",
      plannedDirectories: ["docs/decisions"],
      observedCreatedDirectories: ["docs/decisions"],
    },
    diagnostics: [],
    receiptDigest: `sha256:${"6".repeat(64)}`,
  };
  return receipt;
}

export function badRelationFoundation(
  types: readonly TypeFixture[],
  descriptor: () => DescriptorFixture,
) {
  const badFoundation = {
    async describe() {
      return {
        authority: {},
        projectId: "fixture-project",
        profileSchemaVersion: 3,
        metadataSchemaPath: "docs/metadata.schema.json",
        metadataSidecar: { kind: "none" },
        ownerIds: ["architecture/tooling"],
        types,
        authorityPaths: [],
      };
    },
    async buildCatalog() {
      return {
        projectId: "fixture-project",
        status: "complete",
        diagnostics: [],
        documents: [{ ...descriptor(), metadata: { related: ["ADR-9999"] } }],
        identityProjection: [],
        ownerIds: [],
        authority: {},
      };
    },
    async inspect() {
      return { schemaVersion: 1, state: "idle", diagnostics: [] };
    },
    async find() {
      return [];
    },
    async plan() {
      throw new Error("not used");
    },
    async apply() {
      throw new Error("not used");
    },
    async recover() {
      throw new Error("not used");
    },
  };
  return badFoundation;
}
