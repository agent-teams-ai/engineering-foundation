import { createHash } from "node:crypto";

import type { Sha256DigestPort } from "../../../application/ports/sha256-digest.js";
import type { Sha256Digest } from "../../../application/model/protobuf-release-evidence.js";

export class NodeSha256Digest implements Sha256DigestPort {
  digest(value: string | Uint8Array): Sha256Digest {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
  }
}
