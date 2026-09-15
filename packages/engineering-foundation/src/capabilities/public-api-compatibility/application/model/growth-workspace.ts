/** Policy-facing, inert export evidence; condition and fallback order is semantic. */
export type GrowthExportTarget = string | null | readonly GrowthExportTarget[] | { readonly [condition: string]: GrowthExportTarget };
export interface GrowthWorkspacePackage {
  readonly name: string;
  readonly rootPath: string;
  readonly manifestPath: string;
  readonly moduleType: "commonjs" | "module";
  readonly exportSurface: {
    readonly explicit: boolean;
    readonly entries: readonly { readonly subpath: string; readonly target?: GrowthExportTarget }[];
  };
}
