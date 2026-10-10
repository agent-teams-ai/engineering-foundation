import { configurationInputError as invalid, assertConfigRepositoryRelativePath } from "../../../application/configuration-input.js";
import type { CoverageCheck, CoverageFacet, WorkflowCoveragePolicy } from "../../../application/model/check-changed.js";

function object(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {invalid(`${name} must be an object.`);}
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(result, key))) {invalid(`${name} requires exactly: ${keys.join(", ")}.`);}
  return result;
}
function text(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || (pattern !== undefined && !pattern.test(value))) {invalid(`${name} is invalid.`);}
  return value;
}
function list<T>(value: unknown, name: string, parse: (entry: unknown) => T, min = 1, max = 64): readonly T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {invalid(`${name} requires ${min}..${max} entries.`);}
  return Object.freeze(value.map(parse));
}
function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) {invalid(`${name} must be unique.`);}
}
function id(value: unknown): string { return text(value, "id", /^[a-z][a-z0-9-]{0,62}$/u); }
function script(value: unknown): string { return text(value, "script", /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/u); }
function path(value: unknown): string {
  const result = text(value, "path");
  assertConfigRepositoryRelativePath(result);
  return result;
}
function strings(value: unknown, name: string, parse: (entry: unknown) => string, min = 1): readonly string[] {
  const result = list(value, name, parse, min);
  unique(result, name);
  return result;
}
function facet(value: unknown): CoverageFacet {
  if (value !== "lint" && value !== "typecheck" && value !== "tests" && value !== "standards" && value !== "architecture") {invalid("Unknown coverage facet.");}
  return value;
}
function facets(value: unknown): readonly CoverageFacet[] {
  const result = list(value, "facets", facet, 1, 5);
  unique(result, "facets");
  return result;
}
function check(value: unknown): CoverageCheck {
  const input = object(value, ["id", "script", "prerequisites", "supplies", "observation"], "check");
  const supplies = facets(input["supplies"]);
  const observation = input["observation"];
  if (observation !== "command" && observation !== "test-dispatch/v1") {invalid("Unknown observation contract.");}
  if (supplies.includes("tests") && observation !== "test-dispatch/v1") {invalid("The tests facet requires test-dispatch/v1; exit zero is insufficient.");}
  return Object.freeze({ id: id(input["id"]), script: script(input["script"]), prerequisites: strings(input["prerequisites"], "prerequisites", script, 0), supplies, observation });
}
export function parseAgentWorkflowPolicyV2(value: unknown): WorkflowCoveragePolicy {
  if (typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion === 1) {invalid("check-changed requires repository-agent-workflow/v2. Migrate changedChecks to explicit repository scopes, requiredFacets, supplies and observations; keep changed for historical v1 feedback.");}
  const input = object(value, ["schemaVersion", "instructions", "scripts", "scopes", "checks", "exclusions", "escalationCheck"], "workflow v2");
  if (input["schemaVersion"] !== 2) {invalid("check-changed requires schemaVersion: 2.");}
  const ins = object(input["instructions"], ["canonical", "claude", "gemini", "copilot"], "instructions");
  const instructions = Object.freeze({ canonical: path(ins["canonical"]), claude: path(ins["claude"]), gemini: path(ins["gemini"]), copilot: path(ins["copilot"]) });
  unique(Object.values(instructions), "instruction paths");
  const scr = object(input["scripts"], ["changed", "fast", "full"], "scripts");
  const scripts = Object.freeze({ changed: script(scr["changed"]), fast: script(scr["fast"]), full: script(scr["full"]) });
  const checks = list(input["checks"], "checks", check, 1, 16);
  unique(checks.map((entry) => entry.id), "check ids");
  unique(checks.map((entry) => entry.script), "check scripts");
  if (checks.some((entry) => entry.script === scripts.changed || entry.prerequisites.includes(scripts.changed))) {invalid("The successor cannot invoke itself.");}
  const scopes = list(input["scopes"], "scopes", (entryValue) => {
    const scope = object(entryValue, ["id", "roots", "requiredFacets", "checks"], "scope");
    return Object.freeze({ id: id(scope["id"]), roots: strings(scope["roots"], "roots", (entry) => entry === "*" ? "*" : path(entry)), requiredFacets: facets(scope["requiredFacets"]), checks: strings(scope["checks"], "checks", id) });
  });
  unique(scopes.map((entry) => entry.id), "scope ids");
  const exclusions = list(input["exclusions"], "exclusions", (entryValue) => {
    const entry = object(entryValue, ["path", "reason"], "exclusion");
    return Object.freeze({ path: path(entry["path"]), reason: text(entry["reason"], "exclusion reason") });
  }, 0);
  unique(exclusions.map((entry) => entry.path), "exclusions");
  const escalationCheck = id(input["escalationCheck"]);
  if (!checks.some((entry) => entry.id === escalationCheck) || scopes.some((scope) => scope.checks.some((name) => !checks.some((entry) => entry.id === name)))) {invalid("Unknown check mapping.");}
  return Object.freeze({ schemaVersion: 2, instructions, scripts, scopes, checks, exclusions, escalationCheck });
}
