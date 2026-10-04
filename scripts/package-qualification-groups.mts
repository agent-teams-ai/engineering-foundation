import type { QualificationStage } from "./package-artifact-custody.mts";

export const PACKAGE_PREPARATION_CONCURRENCY = 2;
export const PACKAGE_QUALIFICATION_GROUPS = Object.freeze({
  packed: Object.freeze(["integration", "sdk-growth", "quality-coverage"] as const),
  registry: Object.freeze(["npm-docs", "pnpm-docs", "foundation"] as const),
});
export type PackedQualificationGroup = typeof PACKAGE_QUALIFICATION_GROUPS.packed[number];
export type RegistryQualificationGroup = typeof PACKAGE_QUALIFICATION_GROUPS.registry[number];
const combinedProfiles = Object.freeze({
  foundation: Object.freeze({ packed: "integration", registry: "foundation" }),
  "npm-docs": Object.freeze({ packed: "sdk-growth", registry: "npm-docs" }),
  "pnpm-docs": Object.freeze({ packed: "quality-coverage", registry: "pnpm-docs" }),
} satisfies Record<string, Readonly<{ packed: PackedQualificationGroup; registry: RegistryQualificationGroup }>>);
export const COMBINED_PACKAGE_PROFILES = Object.freeze(["foundation", "npm-docs", "pnpm-docs"] as const);
export type CombinedPackageProfile = typeof COMBINED_PACKAGE_PROFILES[number];
export type PackageQualificationRequest =
  | Readonly<{ mode: "packed"; group: PackedQualificationGroup }>
  | Readonly<{ mode: "registry"; group: RegistryQualificationGroup }>;
export type PackageQualificationPhase = Readonly<{ id: string; run: () => unknown | Promise<unknown> }>;

const completePhases: Readonly<Record<QualificationStage, readonly string[]>> = Object.freeze({
  packed: Object.freeze([
    "Docs integration", "packed consumer E2E", "SDK growth qualification", "authority scaffolding",
    "local-mode lifecycle", "agent-workflow fixture", "quality coverage", "quality gate runner",
  ]),
  registry: Object.freeze([
    "npm-docs-only", "npm-docs-mcp", "pnpm-docs-only", "pnpm-docs-mcp", "npm-foundation",
  ]),
});
const groupPhases: Readonly<Record<QualificationStage, Readonly<Record<string, readonly string[]>>>> =
  Object.freeze({
    packed: Object.freeze({
      integration: Object.freeze([
        "Docs integration", "packed consumer E2E", "authority scaffolding",
        "local-mode lifecycle", "agent-workflow fixture", "quality gate runner",
      ]),
      "sdk-growth": Object.freeze(["SDK growth qualification"]),
      "quality-coverage": Object.freeze(["quality coverage"]),
    } satisfies Record<PackedQualificationGroup, readonly string[]>),
    registry: Object.freeze({
      "npm-docs": Object.freeze(["npm-docs-only", "npm-docs-mcp"]),
      "pnpm-docs": Object.freeze(["pnpm-docs-only", "pnpm-docs-mcp"]),
      foundation: Object.freeze(["npm-foundation"]),
    } satisfies Record<RegistryQualificationGroup, readonly string[]>),
  });

function fail(message: string): never {
  throw new Error(`Package qualification groups: ${message}`);
}

export function combinedPackageQualificationGroups(profile: unknown = undefined): Readonly<{
  packed: PackedQualificationGroup | undefined; registry: RegistryQualificationGroup | undefined;
}> {
  if (profile === undefined) { return Object.freeze({ packed: undefined, registry: undefined }); }
  if (typeof profile !== "string" || !Object.hasOwn(combinedProfiles, profile)) {
    fail("unknown combined profile");
  }
  return combinedProfiles[profile as CombinedPackageProfile];
}

export function parseCombinedQualificationArguments(args: readonly unknown[]): CombinedPackageProfile | undefined {
  if (!Array.isArray(args) || args.length > 1 || (args.length === 1 && typeof args[0] !== "string")) {
    fail("expected zero arguments or one combined profile; no overrides are accepted");
  }
  combinedPackageQualificationGroups(args[0]);
  return args[0] as CombinedPackageProfile | undefined;
}

export function assertCompleteCombinedPackageProfiles(profiles: readonly unknown[]): void {
  if (!Array.isArray(profiles) || profiles.length !== COMBINED_PACKAGE_PROFILES.length ||
      new Set(profiles).size !== profiles.length ||
      COMBINED_PACKAGE_PROFILES.some(profile => !profiles.includes(profile))) {
    fail("combined profiles must cover the complete closed profile set exactly once");
  }
  const selected = profiles.map(profile => combinedPackageQualificationGroups(profile));
  assertCompletePackageQualificationGroups("packed", selected.map(profile => profile.packed));
  assertCompletePackageQualificationGroups("registry", selected.map(profile => profile.registry));
}

// Undefined selects the original complete sequence; named groups are closed.
export function packageQualificationPhaseIds(mode: QualificationStage, group: unknown = undefined): readonly string[] {
  if (mode !== "packed" && mode !== "registry") { fail("unknown qualification mode"); }
  if (group === undefined) { return completePhases[mode]; }
  if (typeof group !== "string" || !Object.hasOwn(groupPhases[mode], group)) {
    fail(`unknown ${mode} group`);
  }
  return groupPhases[mode][group];
}

export function assertCompletePackageQualificationGroups(mode: QualificationStage, groups: readonly unknown[]): void {
  const complete = packageQualificationPhaseIds(mode);
  if (!Array.isArray(groups)) { fail("group set must be an array"); }
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const group of groups) {
    if (typeof group !== "string") { fail("group set contains a missing or invalid group"); }
    const ids = packageQualificationPhaseIds(mode, group);
    if (seen.has(group)) { fail("group set contains a duplicate group"); }
    seen.add(group);
    selected.push(...ids);
  }
  if ([...seen].toSorted().join("\0") !== [...PACKAGE_QUALIFICATION_GROUPS[mode]].toSorted().join("\0")) {
    fail("group set is missing a required group");
  }
  if (selected.toSorted().join("\0") !== complete.toSorted().join("\0")) {
    fail("closed groups do not cover the complete phase inventory exactly once");
  }
}

export function parsePackageQualificationGroupArguments(args: readonly unknown[]): PackageQualificationRequest {
  if (!Array.isArray(args) || args.length !== 2) { fail("expected exactly MODE GROUP; no overrides are accepted"); }
  const [mode, group] = args;
  if ((mode !== "packed" && mode !== "registry") || typeof group !== "string") {
    fail("expected a known mode and named group");
  }
  packageQualificationPhaseIds(mode, group);
  return mode === "packed"
    ? Object.freeze({ mode, group: group as PackedQualificationGroup })
    : Object.freeze({ mode, group: group as RegistryQualificationGroup });
}

// Reject incomplete or reordered dispatch tables before running any effects.
export async function runPackageQualificationPhases(
  mode: QualificationStage, group: unknown, phases: readonly PackageQualificationPhase[],
): Promise<void> {
  const selected = packageQualificationPhaseIds(mode, group);
  const complete = packageQualificationPhaseIds(mode);
  if (!Array.isArray(phases) || phases.some(phase => phase === null || typeof phase !== "object" ||
      typeof phase.id !== "string" || typeof phase.run !== "function") ||
      phases.map(phase => phase.id).join("\0") !== complete.join("\0")) {
    fail("dispatch must contain the complete ordered phase inventory");
  }
  for (const phase of phases) {
    if (selected.includes(phase.id)) { await phase.run(); }
  }
}

// Targets own their A/B stages. Stop admission on failure and drain every
// started target before the invocation owner can clean up its temporary root.
export async function mapIndependentPackageTargets<T, R>(
  targets: readonly T[], prepare: (target: T, index: number) => R | Promise<R>,
  concurrency: number = PACKAGE_PREPARATION_CONCURRENCY,
): Promise<R[]> {
  if (!Array.isArray(targets) || typeof prepare !== "function" || !Number.isSafeInteger(concurrency) ||
      concurrency < 1 || concurrency > PACKAGE_PREPARATION_CONCURRENCY) {
    fail("package preparation concurrency must be an integer between 1 and 2");
  }
  const results: R[] = [];
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= targets.length) { return; }
      try { results[index] = await prepare(targets[index], index); }
      catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
  };
  const settled = await Promise.allSettled(Array.from(
    { length: Math.min(concurrency, targets.length) }, () => worker(),
  ));
  for (const result of settled) {
    if (result.status === "rejected" && !failed) { failed = true; failure = result.reason; }
  }
  if (failed) { throw failure; } // An undefined rejection still poisons production.
  return results;
}

assertCompletePackageQualificationGroups("packed", PACKAGE_QUALIFICATION_GROUPS.packed);
assertCompletePackageQualificationGroups("registry", PACKAGE_QUALIFICATION_GROUPS.registry);
assertCompleteCombinedPackageProfiles(COMBINED_PACKAGE_PROFILES);
