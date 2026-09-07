export type { FoundationCommandErrorEnvelope } from "../../../application/command-reporting.js";
import { foundationCommandFailure as classifyFailure, foundationCommandFailureJson as formatFailure } from "../../../application/command-failure.js";
import type { FoundationCommandErrorEnvelope } from "../../../application/command-reporting.js";

export function foundationCommandFailure(error: unknown): {
  readonly envelope: FoundationCommandErrorEnvelope;
  readonly exitCode: 1 | 2 | 130;
} {
  return classifyFailure(error);
}

export function foundationCommandFailureJson(error: unknown): string {
  return formatFailure(error);
}
