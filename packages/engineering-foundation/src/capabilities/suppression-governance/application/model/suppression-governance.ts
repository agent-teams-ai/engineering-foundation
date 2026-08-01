const WAIVERABLE_DIRECTIVES = [
  "ast-grep-ignore",
  "oxlint-disable-line",
  "oxlint-disable-next-line",
  "typescript-expect-error"
] as const;

export type WaiverableDirective = (typeof WAIVERABLE_DIRECTIVES)[number];

export type SuppressionDirectiveKind =
  | WaiverableDirective
  | "eslint-disable"
  | "eslint-disable-line"
  | "eslint-disable-next-line"
  | "oxlint-disable"
  | "typescript-ignore"
  | "typescript-nocheck";

export interface SuppressionDirective {
  readonly kind: SuppressionDirectiveKind;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly rules: readonly string[];
  readonly scope: "file" | "line";
}

export interface SuppressionScan {
  readonly path: string;
  readonly parseErrorCount: number;
  readonly directives: readonly SuppressionDirective[];
}

export interface SuppressionWaiver {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly directive: WaiverableDirective;
  readonly rules: readonly string[];
  readonly owner: string;
  readonly reason: string;
  readonly createdOn: string;
  readonly expiresOn: string;
  readonly decisionRef: string;
}

export interface SuppressionGovernancePolicy {
  readonly governedRoots: readonly string[];
  readonly nonWaivableRulePrefixes: readonly string[];
  readonly waivers: readonly SuppressionWaiver[];
}
