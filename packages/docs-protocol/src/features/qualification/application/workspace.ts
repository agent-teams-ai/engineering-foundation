export interface QualificationWorkspace {
  readonly resolveRoot: (root: string) => Promise<string>;
  readonly snapshot: (root: string) => Promise<string>;
  readonly fileSnapshot: (root: string) => Promise<ReadonlyMap<string, string>>;
  readonly bootstrapInstallation: (root: string, rewrite: boolean) => Promise<unknown>;
  readonly parentState: (root: string, documentPath: string) => Promise<"directory" | "missing">;
  readonly applyReachability: (root: string, action: unknown) => Promise<void>;
  readonly createDisposable: () => Promise<{
    readonly consumerRoot: string;
    readonly copyFrom: (sourceRoot: string) => Promise<void>;
    readonly dispose: () => Promise<void>;
  }>;
}
