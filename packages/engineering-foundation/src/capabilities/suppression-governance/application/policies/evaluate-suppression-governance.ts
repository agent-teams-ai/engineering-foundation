import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import { isoDateToEpochDay } from "../model/iso-date.js";
import type {
  SuppressionDirective,
  SuppressionGovernancePolicy,
  SuppressionScan,
  SuppressionWaiver,
  WaiverableDirective
} from "../model/suppression-governance.js";
import {
  SUPPRESSION_GOVERNANCE_RULES,
  type SuppressionGovernanceRuleMetadata
} from "../rules.js";

const BUILT_IN_PROTECTED_RULE_PREFIXES = [
  "security.",
  "tenancy.",
  "tenant-isolation."
] as const;
const MAXIMUM_WAIVER_LIFETIME_DAYS = 90;

function diagnostic(input: {
  readonly rule: SuppressionGovernanceRuleMetadata;
  readonly subject: string;
  readonly message: string;
  readonly path: string;
  readonly line: number;
  readonly column?: number;
  readonly evidence?: readonly { readonly kind: string; readonly value: string }[];
}): FoundationDiagnostic {
  return {
    ruleId: input.rule.id,
    severity: input.rule.severity,
    subject: input.subject,
    message: input.message,
    location: {
      path: input.path,
      start: { line: input.line, column: input.column ?? 1 }
    },
    relatedLocations: [],
    evidence: input.evidence ?? [],
    remediation: input.rule.remediation,
    requiresArchitectureReview: input.rule.requiresArchitectureReview
  };
}

function locationKey(path: string, line: number): string {
  return `${path}:${line}`;
}

function exactRules(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.toSorted().every((value, index) => value === right.toSorted()[index])
  );
}

function waiverable(kind: SuppressionDirective["kind"]): kind is WaiverableDirective {
  return (
    kind === "ast-grep-ignore" ||
    kind === "oxlint-disable-line" ||
    kind === "oxlint-disable-next-line" ||
    kind === "typescript-expect-error"
  );
}

function protectedRules(
  directive: SuppressionDirective,
  policy: SuppressionGovernancePolicy
): readonly string[] {
  const prefixes = [
    ...BUILT_IN_PROTECTED_RULE_PREFIXES,
    ...policy.nonWaivableRulePrefixes
  ];
  return directive.rules.filter((ruleId) =>
    prefixes.some((prefix) => ruleId.startsWith(prefix))
  );
}

function classifyProhibited(
  directive: SuppressionDirective,
  policy: SuppressionGovernancePolicy
): FoundationDiagnostic | undefined {
  const base = {
    subject: locationKey(directive.path, directive.line),
    path: directive.path,
    line: directive.line,
    column: directive.column
  };
  if (directive.kind.startsWith("eslint-")) {
    return diagnostic({
      ...base,
      rule: SUPPRESSION_GOVERNANCE_RULES.legacySuppression,
      message: `Legacy suppression directive is prohibited: ${directive.kind}.`
    });
  }
  if (directive.kind === "typescript-ignore" || directive.kind === "typescript-nocheck") {
    return diagnostic({
      ...base,
      rule: SUPPRESSION_GOVERNANCE_RULES.prohibitedTypeScriptSuppression,
      message: `TypeScript suppression directive is prohibited: ${directive.kind}.`
    });
  }
  if (directive.scope === "file") {
    return diagnostic({
      ...base,
      rule: SUPPRESSION_GOVERNANCE_RULES.broadSuppression,
      message: `Broad suppression directive is prohibited: ${directive.kind}.`
    });
  }
  if (directive.rules.length === 0) {
    return diagnostic({
      ...base,
      rule: SUPPRESSION_GOVERNANCE_RULES.unscopedSuppression,
      message: `Suppression directive does not name an exact rule: ${directive.kind}.`
    });
  }
  const blockedRules = protectedRules(directive, policy);
  if (blockedRules.length > 0) {
    return diagnostic({
      ...base,
      rule: SUPPRESSION_GOVERNANCE_RULES.protectedRuleSuppression,
      message: `Suppression targets non-waivable rule(s): ${blockedRules.join(", ")}.`,
      evidence: blockedRules.map((value) => ({ kind: "protected-rule", value }))
    });
  }
  return undefined;
}

function waiverTimeDiagnostics(
  waiver: SuppressionWaiver,
  today: string
): readonly FoundationDiagnostic[] {
  const created = isoDateToEpochDay(waiver.createdOn);
  const expires = isoDateToEpochDay(waiver.expiresOn);
  const current = isoDateToEpochDay(today);
  if (created === undefined || expires === undefined || current === undefined) {
    return [];
  }
  const base = {
    subject: waiver.id,
    path: waiver.path,
    line: waiver.line,
    evidence: [{ kind: "waiver-id", value: waiver.id }]
  };
  const diagnostics: FoundationDiagnostic[] = [];
  if (created > current) {
    diagnostics.push(
      diagnostic({
        ...base,
        rule: SUPPRESSION_GOVERNANCE_RULES.futureWaiver,
        message: `Waiver ${waiver.id} has future createdOn ${waiver.createdOn}.`
      })
    );
  }
  if (expires < current) {
    diagnostics.push(
      diagnostic({
        ...base,
        rule: SUPPRESSION_GOVERNANCE_RULES.expiredWaiver,
        message: `Waiver ${waiver.id} expired on ${waiver.expiresOn}.`
      })
    );
  }
  if (expires - created > MAXIMUM_WAIVER_LIFETIME_DAYS) {
    diagnostics.push(
      diagnostic({
        ...base,
        rule: SUPPRESSION_GOVERNANCE_RULES.excessiveLifetime,
        message: `Waiver ${waiver.id} exceeds ${MAXIMUM_WAIVER_LIFETIME_DAYS} days.`
      })
    );
  }
  return diagnostics;
}

export function evaluateSuppressionGovernance(input: {
  readonly policy: SuppressionGovernancePolicy;
  readonly scans: readonly SuppressionScan[];
  readonly today: string;
}): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const waiversByLocation = new Map(
    input.policy.waivers.map((waiver) => [locationKey(waiver.path, waiver.line), waiver])
  );
  const consumedWaivers = new Set<string>();

  for (const scan of input.scans) {
    if (scan.parseErrorCount > 0) {
      diagnostics.push(
        diagnostic({
          rule: SUPPRESSION_GOVERNANCE_RULES.sourceParseError,
          subject: scan.path,
          message: `Source parser reported ${scan.parseErrorCount} error(s).`,
          path: scan.path,
          line: 1
        })
      );
      continue;
    }
    for (const directive of scan.directives) {
      const key = locationKey(directive.path, directive.line);
      const waiver = waiversByLocation.get(key);
      const prohibited = classifyProhibited(directive, input.policy);
      if (prohibited !== undefined) {
        diagnostics.push(prohibited);
        continue;
      }
      if (!waiverable(directive.kind)) {
        continue;
      }
      if (waiver === undefined) {
        diagnostics.push(
          diagnostic({
            rule: SUPPRESSION_GOVERNANCE_RULES.unregisteredSuppression,
            subject: key,
            message: `Suppression has no registered waiver: ${directive.kind}.`,
            path: directive.path,
            line: directive.line,
            column: directive.column,
            evidence: directive.rules.map((value) => ({ kind: "rule", value }))
          })
        );
        continue;
      }
      consumedWaivers.add(waiver.id);
      if (waiver.directive !== directive.kind || !exactRules(waiver.rules, directive.rules)) {
        diagnostics.push(
          diagnostic({
            rule: SUPPRESSION_GOVERNANCE_RULES.waiverMismatch,
            subject: waiver.id,
            message: `Waiver ${waiver.id} does not match the source directive.`,
            path: directive.path,
            line: directive.line,
            column: directive.column,
            evidence: [{ kind: "waiver-id", value: waiver.id }]
          })
        );
        continue;
      }
      diagnostics.push(...waiverTimeDiagnostics(waiver, input.today));
    }
  }

  for (const waiver of input.policy.waivers) {
    if (!consumedWaivers.has(waiver.id)) {
      diagnostics.push(
        diagnostic({
          rule: SUPPRESSION_GOVERNANCE_RULES.staleWaiver,
          subject: waiver.id,
          message: `Waiver ${waiver.id} does not match one allowed suppression.`,
          path: waiver.path,
          line: waiver.line,
          evidence: [{ kind: "waiver-id", value: waiver.id }]
        })
      );
    }
  }
  return diagnostics;
}
