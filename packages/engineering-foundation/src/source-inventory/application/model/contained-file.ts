export type ContainedFileReadFailure =
  | "changed"
  | "escape"
  | "invalid"
  | "missing"
  | "symlink"
  | "unavailable";

export class ContainedFileReadError extends Error {
  readonly failure: ContainedFileReadFailure;

  constructor(failure: ContainedFileReadFailure) {
    super(`Contained file read failed: ${failure}.`);
    this.name = "ContainedFileReadError";
    this.failure = failure;
  }
}

export interface ContainedFileLocation {
  readonly candidate: string;
  readonly root: string;
}

export interface BoundedFileRead extends ContainedFileLocation {
  readonly maxBytes: number;
}

export interface ContainedFileObservation {
  readonly read: (input: BoundedFileRead) => Promise<Uint8Array>;
  readonly inspect: (input: ContainedFileLocation) => Promise<{ readonly size: number }>;
}
