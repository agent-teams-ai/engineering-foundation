import {
  NPM_PACKAGE_BOOTSTRAP,
  parseBootstrapCatalog,
  verifyLiveBootstrapBaselines,
  verifyReleaseBootstrapBaselines,
} from "../../scripts/npm-package-bootstrap.mjs";

export type Provenance = {
  ref: string;
  repository: string;
  sourceCommit: string;
  workflowPath: string;
};
export type Predecessor = {
  archiveIntegrity: string;
  name: string;
  provenance: Provenance;
  version: string;
};
export type CatalogProfile = {
  approval: { archiveIntegrity: string; packageTree: string } | null;
  bootstrapVersion: string;
  id: string;
  name: string;
  provenance: Provenance;
  releasePredecessor: Predecessor | null;
  state: string;
};
export type MutableCatalog = { packages: Array<CatalogProfile & Record<string, unknown>> };
export type ParsedCatalog = {
  packages: readonly CatalogProfile[];
  registry: string;
  repository: string;
  schemaVersion: number;
};
type PackumentVersion = {
  dist: { integrity: string };
  gitHead?: string | null;
};
export type Packument = {
  versions: Record<string, PackumentVersion>;
  "dist-tags": Record<string, string>;
};
export type ProvenanceStatement = {
  _type: string;
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: { path: string; ref: string; repository: string };
      };
      resolvedDependencies: Array<{ digest: { gitCommit: string }; uri: string }>;
    };
  };
  predicateType: string;
  subject: Array<{ digest: { sha512: string }; name: string }>;
};

export const name = "@agent-teams/ci-input-proof";
export const version = "0.1.0-rc.0";
export const sourceCommit = "598c248b56d134a9fd1dcd86417a2c93538ef65d";
export const archiveIntegrity =
  "sha512-aiOC4nvGRfG6CkLKRG2utkqFAOJNtPojZZYLqmmG5OzhZYKqQCh6T2OOMNqA5vlbccWWEXxismMXE6QDl0vo7w==";
export const changedArchiveIntegrity =
  "sha512-TfvqvgodFFHk8ZuM9rRByn+2WQIrL/lw08s7XlqzI8Ww1O9DU5S9cpaggylbmUjbyiqm7T2itDBmEF33C8DO4A==";
export const predecessor: Predecessor = {
  archiveIntegrity,
  name,
  provenance: {
    ref: "refs/heads/main",
    repository: "https://github.com/agent-teams-ai/engineering-foundation",
    sourceCommit,
    workflowPath: ".github/workflows/ci-input-proof-rc.yml",
  },
  version,
};

export function successorCatalog(): ParsedCatalog {
  const value = structuredClone(NPM_PACKAGE_BOOTSTRAP) as unknown as MutableCatalog;
  value.packages = value.packages.filter((entry) => entry.id === "ci-input-proof");
  const parsed: unknown = parseBootstrapCatalog(value);
  return parsed as ParsedCatalog;
}

export function packageCatalog(id: string): ParsedCatalog {
  const value = structuredClone(NPM_PACKAGE_BOOTSTRAP) as unknown as MutableCatalog;
  value.packages = value.packages.filter((entry) => entry.id === id);
  const parsed: unknown = parseBootstrapCatalog(value);
  return parsed as ParsedCatalog;
}

export function releaseState(packageName: string, packageVersion: string) {
  return {
    packages: {
      private: [],
      public: [
        {
          manifestBytes: JSON.stringify({ name: packageName, version: packageVersion }),
          name: packageName,
          version: packageVersion,
        },
      ],
    },
  };
}

export function generatedReleaseState(packageName: string, packageVersion: string) {
  return {
    controlFiles: [],
    inventory: {
      files: [],
      metadata: ["README.md", "config.json"],
      pending: [],
      unexpected: [],
    },
    packages: {
      private: [],
      public: [
        {
          manifestBytes: JSON.stringify({ name: packageName, version: packageVersion }),
          name: packageName,
          registry: "https://registry.npmjs.org/",
          required: false,
          version: packageVersion,
        },
      ],
    },
    preState: undefined,
  };
}

export function changesetPlan(packageName: string, newVersion: string) {
  return {
    changesets: [
      {
        id: "ci-input-proof-kernel",
        releases: [{ name: packageName, type: "minor" }],
        summary: "Add the reviewed successor.",
      },
    ],
    releases: [
      {
        changesets: ["ci-input-proof-kernel"],
        name: packageName,
        newVersion,
        oldVersion: "0.1.0-rc.0",
        type: "minor",
      },
    ],
    preState: undefined,
  };
}

export function statement(
  workflowPath = predecessor.provenance.workflowPath,
  commit = predecessor.provenance.sourceCommit,
  integrity = archiveIntegrity,
): ProvenanceStatement {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            path: workflowPath,
            ref: predecessor.provenance.ref,
            repository: predecessor.provenance.repository,
          },
        },
        resolvedDependencies: [
          {
            digest: { gitCommit: commit },
            uri: `git+${predecessor.provenance.repository}@${predecessor.provenance.ref}`,
          },
        ],
      },
    },
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        digest: {
          sha512: Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex"),
        },
        name: "pkg:npm/%40agent-teams/ci-input-proof@0.1.0-rc.0",
      },
    ],
  };
}

export function auditEvidence(value: ProvenanceStatement = statement()) {
  return {
    invalid: [],
    missing: [],
    verified: [
      {
        attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
        attestationBundles: [
          {
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(value)).toString("base64"),
                payloadType: "application/vnd.in-toto+json",
              },
            },
            predicateType: "https://slsa.dev/provenance/v1",
          },
          {
            predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
          },
        ],
        name,
        version,
      },
    ],
  };
}

export function packument(integrity = archiveIntegrity, gitHead?: string | null): Packument {
  const published: PackumentVersion = { dist: { integrity } };
  if (gitHead !== undefined) {
    published.gitHead = gitHead;
  }
  return {
    versions: {
      "0.0.0-stage": { dist: { integrity: changedArchiveIntegrity } },
      [version]: published,
    },
    "dist-tags": { latest: version, rc: version },
  };
}

export async function verifyFixture({
  audit = auditEvidence(),
  metadata = packument(),
  mode = "releaseState",
  releaseVersion = "0.2.0",
  status = 200,
}: {
  audit?: ReturnType<typeof auditEvidence>;
  metadata?: Packument;
  mode?: "direct" | "releaseState";
  releaseVersion?: string;
  status?: number;
} = {}) {
  const options = {
    auditPackage: async () => audit,
    catalog: successorCatalog(),
    fetchImplementation: async () =>
      new Response(status === 200 ? JSON.stringify(metadata) : "not found", { status }),
    observationOptions: { attempts: 1, wait: async () => {} },
    readManifest: async () => ({ name, version: releaseVersion }),
    temporaryRoot: undefined,
  };
  return await (mode === "direct"
    ? verifyLiveBootstrapBaselines(options)
    : verifyReleaseBootstrapBaselines({
        ...options,
        readManifest: async () => {
          throw new Error("releaseState must supply the manifest");
        },
        releaseState: releaseState(name, releaseVersion),
      }));
}
