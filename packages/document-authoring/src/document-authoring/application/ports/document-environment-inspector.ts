export interface DocumentEnvironmentInspection {
  readonly installedFoundationVersion: string;
  readonly installedFoundationBuildIdentity: string;
  readonly filesystem: {
    readonly basis: "platform-contract";
    readonly strictDirectoryDurability:
      | "platform-supported"
      | "platform-unsupported";
  };
}

export interface DocumentEnvironmentInspector {
  inspect(
    consumerRoot: string,
    signal?: AbortSignal
  ): Promise<DocumentEnvironmentInspection>;
}
