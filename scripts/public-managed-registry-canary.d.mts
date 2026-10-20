import type {
  DocsProtocolQualificationCohortV3Receipt,
  DocsProtocolQualificationReceiptV3,
} from "../packages/docs-protocol-agent-teams/dist/qualification/index.js";

/** Precise contract for the existing JavaScript Host digest boundary. */
export function assertQualificationReceiptDigest(
  receipt: DocsProtocolQualificationReceiptV3 | DocsProtocolQualificationCohortV3Receipt,
): void;
