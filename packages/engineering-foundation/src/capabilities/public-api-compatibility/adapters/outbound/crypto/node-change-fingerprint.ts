import { createHash } from "node:crypto";

import type { ChangeFingerprint } from "../../../application/ports/change-fingerprint.js";

export class NodeChangeFingerprint implements ChangeFingerprint {
  sha256(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  sha512Integrity(value: string): string {
    return `sha512-${createHash("sha512").update(value, "utf8").digest("base64")}`;
  }
}
