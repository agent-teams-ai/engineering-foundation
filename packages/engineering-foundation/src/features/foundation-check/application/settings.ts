export interface DeclaredCapability {
  readonly id: string;
  readonly configPath: string;
}

export interface FoundationSettings {
  readonly projectId: string;
  readonly declaredCapabilities: readonly DeclaredCapability[];
}

export type FoundationConfigReader = (
  consumerRoot: string,
  signal?: AbortSignal
) => Promise<FoundationSettings>;
