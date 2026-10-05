/** Internal parsed inputs for a future derivation consumer; never receipt authority. */
export type JsonValue = null | boolean | number | string | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
type ByteInput = Readonly<Uint8Array>;
export interface ArchiveInputBinding {
  readonly sha256: string;
  readonly manifestSha256: string;
  readonly manifestPath: string;
}
export interface RestorationInputBindings {
  readonly originalClosureSha256: string;
  readonly sourceLockSha256: string;
  readonly sourceLockBlob: string;
  readonly actualLockSha256: string;
  readonly archives: Readonly<Record<string, ArchiveInputBinding>>;
}
export interface RestorationInputBytes {
  readonly original: ByteInput;
  readonly source: ByteInput;
  readonly actual: ByteInput;
  readonly archives: Readonly<Record<string, ByteInput>>;
}
export interface ParsedInputDocument {
  readonly bytes: readonly number[];
  readonly tree: JsonObject;
}
export interface ParsedArchiveInput {
  readonly coordinate: string;
  readonly integrity: string;
  readonly compressedSha256: string;
  readonly manifestBytes: readonly number[];
  readonly manifest: JsonObject;
}
export interface ParsedRestorationLockInputs {
  readonly original: ParsedInputDocument;
  readonly source: ParsedInputDocument;
  readonly actual: ParsedInputDocument;
  readonly archives: Readonly<Record<string, ParsedArchiveInput>>;
}
