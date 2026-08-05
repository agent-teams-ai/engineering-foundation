import type { Sha256Digest } from "../model/protobuf-release-evidence.js";

export interface Sha256DigestPort {
  digest(value: string | Uint8Array): Sha256Digest;
}
