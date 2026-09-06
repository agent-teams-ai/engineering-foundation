export const DOCS_PROTOCOL_ID = "agent-teams.docs-protocol" as const;

export const DOCS_PROTOCOL_VERSION = 1 as const;

export const DOCS_ADOPTION_MAX_ROUTING_BYTES = 64 * 1024;

export const DOCS_ADOPTION_MAX_SKILL_BYTES = 16 * 1024;

export interface DocsTypeProfile {
  readonly type: string;
  readonly initialStatus: string;
  readonly allowedOwnerIds: readonly string[];
  readonly identity: {
    readonly format: "adr-four-digits" | "open-decision-three-digits" | "qualified";
  };
  readonly heading: { readonly kind: "id-colon-title" | "title" };
  readonly placement:
    | { readonly kind: "collection"; readonly [key: string]: unknown }
    | {
        readonly kind: "explicit";
        readonly requiredSegmentsInOrder: readonly string[];
      }
    | { readonly kind: "qualified-leaf-index"; readonly [key: string]: unknown };
  readonly requiredMetadata: readonly string[];
  readonly reachability:
    | { readonly kind: "manual-fixed-index"; readonly indexPath: string }
    | {
        readonly kind: "manual-colocated-index";
        readonly indexBasename: "README.md";
        readonly pathPrefix: "before-required-segments";
      }
    | { readonly kind: "not-required"; readonly reason: string };
}

export interface DocsCodeAnchor {
  readonly enforcement: "advisory" | "required";
  readonly pattern: string;
}

export interface ReachabilityAction {
  readonly state: "manual-required" | "not-required";
  readonly indexPath?: string;
  readonly markdownLink?: string;
  readonly reason?: string;
}

export interface DocsProtocolProfileV3 {
  readonly schemaVersion: 3;
  readonly protocol: {
    readonly id: typeof DOCS_PROTOCOL_ID;
    readonly version: typeof DOCS_PROTOCOL_VERSION;
  };
  readonly foundationProfile: {
    readonly metadataSidecarPolicy: "foundation-profile-v3-strict-merge";
    readonly path: string;
    readonly schemaVersion: 3;
  };
  readonly agentWorkflow: {
    readonly adoption: "portable-v1";
    readonly skillPath: string;
  };
  readonly semanticValidatorIds: readonly string[];
}

export interface DocsBlockerPolicy {
  readonly statuses: readonly string[];
  readonly subjectIncompatibleStatuses: readonly string[];
  readonly types: readonly string[];
}

export interface DocsProtocolProfileV4 {
  readonly schemaVersion: 4;
  readonly protocol: DocsProtocolProfileV3["protocol"];
  readonly foundationProfile: DocsProtocolProfileV3["foundationProfile"];
  readonly agentWorkflow: DocsProtocolProfileV3["agentWorkflow"];
  readonly relations: { readonly blockers: DocsBlockerPolicy };
  readonly semanticValidatorIds: readonly string[];
}

export type NormalizedDocsProtocolProfile = (DocsProtocolProfileV3 | DocsProtocolProfileV4) & {
  readonly adoptionPolicy: "portable-v1";
};
