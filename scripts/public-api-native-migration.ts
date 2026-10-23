import { isDeepStrictEqual } from "node:util";
import {
  readContainedRegularFile,
  pathTraversesSymbolicLink,
} from "../packages/engineering-foundation/dist/source-inventory/node.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import { PUBLIC_API_COMPATIBILITY_RULES } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/rules.js";
import { assertNativeMigrationReview as assertSharedReview } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/validate-native-tool-transition.js";
import { prepareNativeMigrationPromotion as prepareSharedPromotion } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/prepare-native-tool-transition.js";
import { createNativeTransitionContent } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-tool-transition-content.js";
import type { PublicApiCompatibilityPolicy as Policy } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/public-api.js";
import type {
  FoundationCheckReport,
  FoundationDiagnostic,
} from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import {
  nativeMigrationPackageNames as packageNames,
  nativeMigrationFrom,
  nativeMigrationTo,
  type NativeMigrationObservation,
} from "./public-api-native-migration-observation.ts";
import type { NativeMigrationReview } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/native-tool-transition.js";
export {
  observeNativeMigration,
  migrationBytes,
  migrationDigest,
} from "./public-api-native-migration-observation.ts";
export type {
  NativeMigrationObservation,
  NativeMigrationPackageInput,
  NativeMigrationPackageObservation,
  NativeMigrationToolDifference,
  MigrationDigest,
} from "./public-api-native-migration-observation.ts";
export type { NativeMigrationReview } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/native-tool-transition.js";
export type { NativeMigrationPlan } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/prepare-native-tool-transition.js";
const nativeTransitionContent = createNativeTransitionContent({
  files: { read: readContainedRegularFile },
  paths: { traversesSymbolicLink: pathTraversesSymbolicLink },
});
function fail(message: string): never {
  throw new Error(`Native public API migration: ${message}`);
}
function assertEight(
  policy: Policy,
  observation: NativeMigrationObservation,
  review: NativeMigrationReview,
): void {
  for (const names of [
    policy.packages.map((p) => p.packageName),
    observation.packages.map((p) => p.packageName),
    review.packages.map((p) => p.packageName),
  ]) {
    if (!isDeepStrictEqual(names.toSorted(), packageNames)) {
      fail("the complete closed eight-package inventory is required");
    }
  }
}
export function assertNativeMigrationReview(
  observation: NativeMigrationObservation,
  review: NativeMigrationReview,
  policy: Policy,
): void {
  assertEight(policy, observation, review);
  assertSharedReview(observation, review, policy, nativeTransitionContent);
}
export async function prepareNativeMigrationPromotion(
  options: Parameters<typeof prepareSharedPromotion>[0],
  dependencies: Omit<Parameters<typeof prepareSharedPromotion>[1], "content">,
) {
  const input = {
    consumerRoot: options.consumerRoot,
    policy: structuredClone(options.policy),
    observation: structuredClone(options.observation),
    review: structuredClone(options.review),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  assertEight(input.policy, input.observation, input.review);
  return prepareSharedPromotion(input, { ...dependencies, content: nativeTransitionContent });
}
function assertPublicApiMismatchCapability(
  capability: FoundationCheckReport["capabilities"][number],
  report: FoundationCheckReport,
  expectedDiagnostics: readonly FoundationDiagnostic[],
): void {
  if (
    capability.outcome !== "violations" ||
    !isDeepStrictEqual(capability.summary, report.summary) ||
    !isDeepStrictEqual(
      capability.diagnostics.toSorted((a, b) => a.subject.localeCompare(b.subject)),
      expectedDiagnostics.toSorted((a, b) => a.subject.localeCompare(b.subject)),
    )
  ) {
    fail("ordinary diagnostic shapes, subjects or paths differ");
  }
}

export async function assertNativeMigrationOrdinaryReport(options: {
  readonly report: unknown;
  readonly exitCode: number;
  readonly observation: NativeMigrationObservation;
  readonly review: NativeMigrationReview;
  readonly policy: Policy;
  readonly expectedCapabilities: readonly {
    readonly capabilityId: string;
    readonly capabilityConfigSchemaVersion: number;
  }[];
}): Promise<void> {
  const input = structuredClone(options);
  assertNativeMigrationReview(input.observation, input.review, input.policy);
  await assertNativeMigrationOrdinaryMismatchReport(input);
  if (
    input.observation.typedDiagnostics.length !== 0 ||
    input.observation.artifactDiagnostics.length !== 0
  ) {
    fail("native candidate compatibility is incomplete or rejected");
  }
}

/** Early negative admission only; it cannot qualify a migration without the
 * independent actual archive/candidate observation checked by the full assertion. */
export async function assertNativeMigrationOrdinaryMismatchReport(options: {
  readonly report: unknown;
  readonly exitCode: number;
  readonly policy: Policy;
  readonly expectedCapabilities: readonly {
    readonly capabilityId: string;
    readonly capabilityConfigSchemaVersion: number;
  }[];
}): Promise<void> {
  const input = structuredClone(options);
  await assertSchema("foundation-check-report/v1", input.report, "public-api-native-migration");
  const report = input.report as FoundationCheckReport;
  if (
    input.exitCode !== 1 ||
    report.coverage !== "full" ||
    report.outcome !== "violations" ||
    report.problem !== undefined ||
    !isDeepStrictEqual(report.summary, { errors: packageNames.length, warnings: 0, infos: 0 })
  ) {
    fail("ordinary full report is not the exact retained mismatch result");
  }
  const expectedInventory = input.expectedCapabilities.toSorted((a, b) =>
    a.capabilityId.localeCompare(b.capabilityId),
  );
  const observedInventory = report.capabilities
    .map(({ capabilityId, capabilityConfigSchemaVersion }) => ({
      capabilityId,
      capabilityConfigSchemaVersion,
    }))
    .toSorted((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  if (
    expectedInventory.length === 0 ||
    new Set(expectedInventory.map((x) => x.capabilityId)).size !== expectedInventory.length ||
    !isDeepStrictEqual(expectedInventory, observedInventory)
  ) {
    fail("ordinary full capability inventory changed");
  }
  const rule = PUBLIC_API_COMPATIBILITY_RULES.baselineToolMismatch;
  const expectedDiagnostics: FoundationDiagnostic[] = input.policy.packages.map((p) => ({
    ruleId: rule.id,
    severity: rule.severity,
    subject: p.packageName,
    message: `Released baseline uses API Extractor ${nativeMigrationFrom}; current adapter uses ${nativeMigrationTo}.`,
    location: { path: p.releasedBaselinePath },
    relatedLocations: [],
    evidence: [],
    remediation: rule.remediation,
    requiresArchitectureReview: rule.requiresArchitectureReview,
  }));
  let foundPublicApi = false;
  for (const capability of report.capabilities) {
    if (capability.problem !== undefined) {
      fail("ordinary capability has an execution/input problem");
    }
    if (capability.capabilityId === "package.public-api-compatibility") {
      foundPublicApi = true;
      assertPublicApiMismatchCapability(capability, report, expectedDiagnostics);
    } else if (
      capability.outcome !== "passed" ||
      capability.diagnostics.length !== 0 ||
      !isDeepStrictEqual(capability.summary, { errors: 0, warnings: 0, infos: 0 })
    ) {
      fail(`ordinary nonmigration diagnostic retained: ${capability.capabilityId}`);
    }
  }
  if (!foundPublicApi) {
    fail("native candidate compatibility is incomplete or rejected");
  }
}
