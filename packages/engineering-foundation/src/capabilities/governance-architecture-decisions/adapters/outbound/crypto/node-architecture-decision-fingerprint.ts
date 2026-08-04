import { createHash } from "node:crypto";

import type { ArchitectureDecisionFingerprint } from "../../../application/ports/architecture-decision-fingerprint.js";

export class NodeArchitectureDecisionFingerprint
  implements ArchitectureDecisionFingerprint
{
  digest(payload: string): string {
    return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
  }
}
