/** Observations selected by scaffolding composition; no default infrastructure. */
export interface ScaffoldAuthorityObservation {
  readonly parseYaml: (source: string, phase: string) => unknown;
  readonly pathTraversesSymbolicLink: (root: string, candidate: string) => Promise<boolean>;
}

export type ScaffoldInstalledVersion = () => Promise<string>;
