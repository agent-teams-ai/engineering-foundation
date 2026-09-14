export interface AuditFileIdentity {
  readonly path: string;
  readonly digest: string;
}

export interface AuditPackageInput {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly manifestPath: string;
  readonly tsconfigPath: string;
  readonly entrypoints: readonly { readonly exportPath: string; readonly declarationEntryPoint: string }[];
  readonly nonTypeExports: readonly { readonly exportPath: string; readonly kind: "data" | "runtime" | "wildcard" }[];
}
export interface AuditDeclarationInput {
  readonly packages: readonly AuditPackageInput[];
  /** Exact complete allowed non-toolchain input set, including configs and manifests. */
  readonly files: readonly AuditFileIdentity[];
  readonly resolutionUniverse: readonly { readonly packageName: string; readonly exportPath: string; readonly declarationPath: string }[];
}
/** Content-addressed evidence in an externally frozen namespace. Preparation
 * must finish and all writers must be excluded before the request is consumed;
 * the auditor cannot verify that external custody precondition.
 */
export interface PublicApiAuditRequest {
  readonly schemaVersion: 1;
  readonly subjects: {
    readonly A: AuditDeclarationInput & {
      readonly archive: { readonly digest: string; readonly extractedMembers: readonly AuditFileIdentity[] };
    };
    readonly B: { readonly baselines: readonly { readonly packageName: string; readonly path: string; readonly digest: string }[] };
    readonly C: AuditDeclarationInput & {
      readonly build: { readonly sourceIdentity: string; readonly buildIdentity: string; readonly declarations: readonly AuditFileIdentity[] };
    };
  };
}
