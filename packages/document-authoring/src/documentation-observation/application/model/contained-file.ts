export type ContainedFileReadFailure =
  | "changed" | "escape" | "invalid" | "missing" | "symlink" | "unavailable";

export class ContainedFileReadError extends Error {
  readonly failure: ContainedFileReadFailure;
  constructor(kind: ContainedFileReadFailure) {
    super(`Contained file read failed: ${kind}.`);
    this.name = "ContainedFileReadError";
    this.failure = kind;
  }
}

interface ContainedFileReadRequest {
  readonly candidate: string;
  readonly maxBytes: number;
  readonly root: string;
}
export type ContainedFileReader = (input: ContainedFileReadRequest) => Promise<Uint8Array>;
