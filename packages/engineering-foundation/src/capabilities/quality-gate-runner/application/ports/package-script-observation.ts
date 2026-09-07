export type PackageScriptObservation = (input: {
  readonly root: string;
  readonly candidate: string;
  readonly maxBytes: number;
}) => Promise<Uint8Array>;
