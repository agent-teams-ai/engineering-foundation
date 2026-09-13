import type { FoundationDiagnostic } from "../../validation-reporting/api.js";
import type { ProtectedSetting, QualityCoverageObservation } from "./model.js";
import { qualitySourceLanguage } from "./source-coverage.js";
import { qualityDiagnostic } from "./rules.js";

export function evaluateStaticCoverage(observation: QualityCoverageObservation): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  for (const path of observation.unclassifiedPackages ?? []) {
    diagnostics.push(qualityDiagnostic("source-package", path, path, "classified production package", "unknown package"));
  }
  if (!observation.sources.some(({ path }) => qualitySourceLanguage(path) === "typescript")) {
    diagnostics.push(qualityDiagnostic("source-empty", "foundation.config.yaml", "production", "nonempty TypeScript production scope", "no TypeScript source"));
  }
  for (const source of observation.sources) {
    if (source.owners.length !== 1) {
      diagnostics.push(qualityDiagnostic("source-classification", source.path, source.path, "one semantic owner", source.owners.join(", ")));
    }
    if (qualitySourceLanguage(source.path) === "native") {
      const gates = source.nativeGates ?? [];
      if (gates.length !== 1 || gates[0]?.reached !== true) {
        diagnostics.push(qualityDiagnostic("native-route", source.path, source.path, "one required consumer native gate", "missing, ambiguous or unreachable gate"));
      }
    } else if (qualitySourceLanguage(source.path) === "unsupported") {
      diagnostics.push(qualityDiagnostic("source-language", source.path, source.path, "TypeScript source or JavaScript module", source.path));
    }
    if (!source.suppressionCovered) {
      diagnostics.push(qualityDiagnostic("suppression-coverage", source.path, source.path, "governed", "outside suppression scope"));
    }
  }
  diagnostics.push(...evaluateProtectedSettings(observation));
  for (const mode of ["scope", "full"] as const) {
    if (!observation.requiredRoutes.some((route) => route.mode === mode)) {
      diagnostics.push(qualityDiagnostic("required-route", "package.json", "routes", mode, "missing required mode observation"));
    }
  }
  for (const required of observation.requiredRoutes) {
    const matches = observation.routes.filter((route) => route.entry === required.entry && route.mode === required.mode);
    if (matches.length !== 1) {
      diagnostics.push(qualityDiagnostic("required-route", "package.json", required.entry, required.mode, "missing or duplicate required route identity"));
    }
  }
  for (const route of observation.routes) {
    if (!observation.requiredRoutes.some((required) => required.entry === route.entry && required.mode === route.mode)) {
      diagnostics.push(qualityDiagnostic("required-route", "package.json", route.entry, "accepted entry and mode", "unknown route identity"));
    }
    if (!route.reached) {
      diagnostics.push(qualityDiagnostic("required-route", "package.json", route.entry, route.mode, "missing executable route"));
    }
  }
  return diagnostics;
}

export function evaluateSelectedCoverage(production: readonly string[], selected: readonly string[], tests: readonly string[]): readonly FoundationDiagnostic[] {
  const expected = new Set(production);
  const actual = new Set(selected);
  const classifiedTests = new Set(tests);
  const diagnostics: FoundationDiagnostic[] = [];
  for (const path of expected) {
    if (!actual.has(path)) {
      diagnostics.push(qualityDiagnostic("selection-mismatch", path, path, "selected production source", "not selected"));
    }
  }
  for (const path of actual) {
    if (!expected.has(path) && !classifiedTests.has(path)) {
      diagnostics.push(qualityDiagnostic("selection-mismatch", path, path, "classified production or test source", "unknown selected source"));
    }
  }
  return diagnostics;
}

export function evaluateTypeContext(production: readonly string[], context: readonly string[]): readonly FoundationDiagnostic[] {
  const included = new Set(context);
  return production.filter((path) => !included.has(path)).map((path) =>
    qualityDiagnostic("type-context", path, path, "included in production project", "absent from compiler project")
  );
}

function preservesSetting(setting: ProtectedSetting): boolean {
  if (setting.comparison === "equal") { return setting.actual === setting.expected; }
  return typeof setting.actual === "number" && typeof setting.expected === "number" &&
    Number.isFinite(setting.actual) && Number.isFinite(setting.expected) &&
    setting.actual >= 0 && setting.expected >= 0 && setting.actual <= setting.expected;
}

function evaluateProtectedSettings(observation: QualityCoverageObservation): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  if (observation.settings.length === 0) {
    diagnostics.push(qualityDiagnostic("protected-setting", "foundation.config.yaml", "settings", "nonempty protected observations", "empty"));
  }
  const requiredSettings = observation.requiredSettings;
  if (requiredSettings.length === 0) {
    diagnostics.push(qualityDiagnostic("protected-setting", "foundation.config.yaml", "requirements", "nonempty preset requirements", "empty"));
  }
  for (const name of new Set(["typeAware", ...requiredSettings])) {
    if (!observation.settings.some((setting) => setting.name === name)) {
      diagnostics.push(qualityDiagnostic("protected-setting", "foundation.config.yaml", name, "required setting observation", "missing"));
    }
  }
  diagnostics.push(...evaluateSettingIdentities(observation));
  for (const setting of observation.settings) {
    const preserved = preservesSetting(setting);
    if (!preserved) {
      diagnostics.push(qualityDiagnostic("protected-setting", setting.path, setting.name, String(setting.expected), String(setting.actual)));
    }
  }
  return diagnostics;
}

function evaluateSettingIdentities(observation: QualityCoverageObservation): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const requirements = observation.requiredSettingObservations;
  if (requirements.length === 0) {
    diagnostics.push(qualityDiagnostic("protected-setting", "foundation.config.yaml", "assignments", "complete configuration requirements", "empty"));
  }
  const identities = new Set<string>();
  for (const required of requirements) {
    const count = observation.settings.filter((setting) => setting.observationId === required.observationId).length;
    if (!required.observationId || identities.has(required.observationId) || count !== 1) {
      diagnostics.push(qualityDiagnostic("protected-setting", required.path, required.name, "one required assignment observation", "missing or duplicate identity"));
    }
    identities.add(required.observationId);
  }
  for (const setting of observation.settings) {
    if (!requirements.some((required) => required.observationId === setting.observationId &&
      required.path === setting.path && required.name === setting.name &&
      required.expected === setting.expected && required.comparison === setting.comparison)) {
      diagnostics.push(qualityDiagnostic("protected-setting", setting.path, setting.name, "accepted assignment identity and requirement", "unknown or altered assignment"));
    }
  }
  return diagnostics;
}
