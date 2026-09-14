import { createRequire } from "node:module";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ProtectedSetting, RequiredProtectedSetting } from "../api.js";
import { invalidQualityInput, qualityRecord, qualityStrings } from "./profile-input.js";

interface OverrideScope {
  readonly files: readonly string[];
  readonly production: readonly string[];
  readonly tests: readonly string[];
}

function isTestOnlyOverride(override: Record<string, unknown>, scope: OverrideScope): boolean {
  const patterns = qualityStrings(override["files"]);
  const excluded = override["excludedFiles"] === undefined ? [] : qualityStrings(override["excludedFiles"]);
  if (patterns.length === 0) { invalidQualityInput("Overrides require nonempty file selectors."); }
  const selected = scope.files.filter((path) => patterns.some((pattern) => posix.matchesGlob(path, pattern)) &&
    !excluded.some((pattern) => posix.matchesGlob(path, pattern)));
  if (selected.length === 0) { invalidQualityInput("Override selector classification has no observed files."); }
  if (selected.some((path) => !scope.production.includes(path) && !scope.tests.includes(path))) {
    invalidQualityInput("Override selector includes files without production or test classification.");
  }
  return selected.every((path) => scope.tests.includes(path));
}

type DataReader = (root: string, path: string) => Promise<unknown>;

function requirement(path: string, group: string, name: string, expected: string | number, comparison: "equal" | "ceiling" = "equal"): RequiredProtectedSetting {
  return { observationId: `${path}#${group}#${name}`, path, name, expected, comparison };
}

function severity(value: unknown): string {
  const input: unknown = Array.isArray(value) ? value[0] : value;
  return input === "error" || input === "deny" || input === 2 ? "error" : String(input);
}

function ceiling(value: unknown): number | undefined {
  if (!Array.isArray(value)) { return undefined; }
  const option: unknown = value[1];
  if (typeof option === "number") { return option; }
  if (typeof option === "object" && option !== null && "max" in option && typeof option.max === "number") { return option.max; }
  return undefined;
}

async function protectedRules(read: DataReader): Promise<ReadonlyMap<string, unknown>> {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const typed = qualityRecord(await read(root, "presets/oxlint/type-aware.json"));
  const maintainability = qualityRecord(await read(root, "presets/oxlint/maintainability.json"));
  return new Map(Object.entries({ ...qualityRecord(typed["rules"]), ...qualityRecord(maintainability["rules"]) })
    .filter(([, value]) => severity(value) === "error"));
}

async function configPath(root: string, physicalRoot: string, from: string, reference: string): Promise<string> {
  if (!reference.endsWith(".json") || isAbsolute(reference)) { invalidQualityInput("V1 quality coverage accepts contained JSON Oxlint configuration only."); }
  let path: string;
  try { path = await realpath(createRequire(join(root, dirname(from), "package.json")).resolve(reference)); }
  catch { invalidQualityInput("An Oxlint extends configuration is missing or unsupported."); }
  const suffix = relative(physicalRoot, path);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) { invalidQualityInput("Oxlint configuration escapes the consumer root."); }
  return suffix.split(sep).join("/");
}

function requiredRuleAssignments(
  path: string, group: string, values: Record<string, unknown>, required: ReadonlyMap<string, unknown>, testOnly: boolean
): readonly RequiredProtectedSetting[] {
  const assignments: RequiredProtectedSetting[] = [];
  for (const [name, expected] of required) {
    const suffix = name.split("/").at(-1);
    if (Object.keys(values).some((key) => key !== name && key.split("/").at(-1) === suffix)) {
      invalidQualityInput(`Use the canonical protected rule identifier: ${name}.`);
    }
    if (!Object.hasOwn(values, name)) { continue; }
    assignments.push(requirement(path, group, name, "error"));
    const actual = values[name];
    const requiredMaximum = ceiling(expected);
    const maximum = testOnly && requiredMaximum !== undefined ? ceiling(actual) ?? requiredMaximum : requiredMaximum;
    if (maximum !== undefined) {
      assignments.push(requirement(path, group, `${name}:ceiling`, maximum, "ceiling"));
    } else if (Array.isArray(actual) && actual.length > 1) {
      invalidQualityInput(`Protected rule options require separate adapter qualification: ${name}.`);
    }
  }
  return assignments;
}

function observeRuleAssignments(assignments: readonly RequiredProtectedSetting[], values: Record<string, unknown>): readonly ProtectedSetting[] {
  return assignments.map((entry) => ({
    ...entry,
    actual: entry.comparison === "ceiling"
      ? ceiling(values[entry.name.slice(0, -":ceiling".length)]) ?? "missing numeric ceiling"
      : severity(values[entry.name])
  }));
}

function retainStrongerCeilings(rules: Record<string, unknown>, required: Map<string, unknown>): void {
  for (const [name, expected] of required) {
    const previous = ceiling(expected);
    const current = ceiling(rules[name]);
    if (previous !== undefined && current !== undefined && Number.isFinite(current) && current >= 0 && current < previous) {
      required.set(name, rules[name]);
    }
  }
}

/** A bounded validation of the supported JSON form, never a general effective-config interpreter. */
export async function inspectProtectedConfig(root: string, lintPath: string, read: DataReader, scope: OverrideScope): Promise<{
  readonly requiredSettings: readonly string[];
  readonly requiredSettingObservations: readonly RequiredProtectedSetting[];
  readonly settings: readonly ProtectedSetting[];
}> {
  const physicalRoot = await realpath(root);
  const required = new Map(await protectedRules(read));
  const requiredSettings = ["typeAware", "respectEslintDisableDirectives", "reportUnusedDisableDirectives", ...[...required].flatMap(([name, value]) =>
    ceiling(value) === undefined ? [name] : [name, `${name}:ceiling`])];
  const seen = new Set<string>();
  const active = new Set<string>();
  const assigned = new Set<string>();
  const requiredSettingObservations: RequiredProtectedSetting[] = [];
  const output: ProtectedSetting[] = [];
  function inspectAssignments(path: string, group: string, values: Record<string, unknown>, testOnly = false): void {
    const assignments = requiredRuleAssignments(path, group, values, required, testOnly);
    requiredSettingObservations.push(...assignments);
    output.push(...observeRuleAssignments(assignments, values));
  }
  function inspectOption(path: string, group: string, name: string, expected: string, actual: string): void {
    const entry = requirement(path, group, name, expected);
    requiredSettingObservations.push(entry);
    output.push({ ...entry, actual });
  }
  let typed = false;
  let rootOptions: Record<string, unknown> = {};
  async function visit(path: string): Promise<void> {
    if (active.has(path)) { invalidQualityInput("Oxlint extends contains a cycle."); }
    if (seen.has(path)) { return; }
    if (seen.size >= 32) { invalidQualityInput("Oxlint configuration exceeds the qualified JSON closure limit."); }
    seen.add(path); active.add(path);
    const value = qualityRecord(await read(root, path));
    if (value["jsPlugins"] !== undefined) { invalidQualityInput("Executable Oxlint plugins are outside this qualified configuration form."); }
    for (const reference of value["extends"] === undefined ? [] : qualityStrings(value["extends"])) {
      await visit(await configPath(root, physicalRoot, path, reference));
    }
    const rules = value["rules"] === undefined ? {} : qualityRecord(value["rules"]);
    for (const name of Object.keys(rules)) { assigned.add(name); }
    inspectAssignments(path, "rules", rules);
    retainStrongerCeilings(rules, required);
    if (value["options"] !== undefined) {
      const options = qualityRecord(value["options"]);
      if (path === lintPath) { rootOptions = options; }
      if (options["typeAware"] !== undefined) {
        if (typed) { inspectOption(path, "options", "typeAware", "true", scalarSetting(options["typeAware"])); }
        typed = options["typeAware"] === true;
      }
    }
    const overrides = value["overrides"];
    if (overrides !== undefined) {
      if (!Array.isArray(overrides) || overrides.length > 1000) { invalidQualityInput("Oxlint overrides must be a bounded data list."); }
      for (const [index, entry] of overrides.entries()) {
        const override = qualityRecord(entry);
        if (Object.keys(override).some((key) => !["files", "excludedFiles", "rules"].includes(key))) { invalidQualityInput("V1 overrides support file selectors and rules only."); }
        const testOnly = isTestOnlyOverride(override, scope);
        inspectAssignments(path, `override:${index}`, qualityRecord(override["rules"]), testOnly);
      }
    }
    active.delete(path);
  }
  await visit(lintPath);
  for (const [name, expected] of [["respectEslintDisableDirectives", "false"], ["reportUnusedDisableDirectives", "error"]] as const) {
    const value = rootOptions[name];
    inspectOption(lintPath, "options", name, expected, value === undefined ? "not configured" : scalarSetting(value));
  }
  inspectOption(lintPath, "effective", "typeAware", "true", String(typed));
  for (const name of required.keys()) {
    if (!assigned.has(name)) { inspectOption(lintPath, "effective", name, "error", "not configured"); }
  }
  return { requiredSettings, requiredSettingObservations, settings: output };
}

function scalarSetting(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") { return String(value); }
  invalidQualityInput("Protected options must have scalar values.");
}
