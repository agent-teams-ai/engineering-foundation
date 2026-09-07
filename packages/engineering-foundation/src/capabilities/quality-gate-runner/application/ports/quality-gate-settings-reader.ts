export type QualityGateSettingsReader = (
  consumerRoot: string,
  signal?: AbortSignal
) => Promise<{
  readonly projectId: string;
  readonly declaredCapabilities: readonly {
    readonly id: string;
    readonly configPath: string;
  }[];
}>;
