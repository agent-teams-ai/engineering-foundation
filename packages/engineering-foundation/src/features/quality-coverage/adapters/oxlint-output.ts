import { qualityDiagnostic, type OxlintFinding } from "../api.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(): never {
  throw new Error("Pinned Oxlint returned malformed execution evidence.");
}

function normalizeSelectedPath(value: string): string {
  const path = value.replaceAll("\\", "/");
  if (path.length === 0 || path.length > 1024 || path.includes(":") || path.split("").some((character) => character < " ") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    malformed();
  }
  return path;
}

export function parseOxlintSelection(stdout: string): readonly string[] {
  const lines = stdout.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const paths = lines.map(normalizeSelectedPath);
  if (paths.length === 0 || new Set(paths).size !== paths.length) { malformed(); }
  return paths.toSorted();
}

interface OxlintEntry {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** The exit status and JSON envelope must agree; a tool failure is never a lint finding. */
function parseOxlintEnvelope(stdout: string, exitCode: number): { readonly files: number; readonly entries: readonly OxlintEntry[] } {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { malformed(); }
  if (!record(value) || !Array.isArray(value["diagnostics"]) ||
    typeof value["number_of_files"] !== "number" || !Number.isSafeInteger(value["number_of_files"]) ||
    value["number_of_files"] < 1 || ![0, 1].includes(exitCode)) { malformed(); }
  const entries = value["diagnostics"].map((input: unknown): OxlintEntry => {
    if (!record(input) || typeof input["filename"] !== "string" ||
      typeof input["code"] !== "string" || !/^[a-z][a-z-]*\([a-z][a-z0-9-]*\)$/u.test(input["code"]) ||
      (input["severity"] !== "error" && input["severity"] !== "warning")) { malformed(); }
    return { path: normalizeSelectedPath(input["filename"]), code: input["code"], message: typeof input["message"] === "string" ? input["message"] : "" };
  });
  if ((exitCode === 0) !== (entries.length === 0)) { malformed(); }
  return { files: value["number_of_files"], entries };
}

export function parseOxlintDiagnostics(stdout: string, exitCode: number): {
  readonly files: number;
  readonly diagnostics: readonly ReturnType<typeof qualityDiagnostic>[];
} {
  const { files, entries } = parseOxlintEnvelope(stdout, exitCode);
  const diagnostics = entries.map(({ path, code }) => {
    const diagnostic = qualityDiagnostic("lint-violation", path, `${path}:${code}`, "no lint violations", code);
    return { ...diagnostic, evidence: [...diagnostic.evidence, { kind: "tool-rule", value: code }] };
  });
  return { files, diagnostics };
}

/**
 * Counts findings per file and rule. A measured rule carries its value in the first
 * parenthesized integer of its message ("... too many lines (612). Maximum allowed is 500.").
 */
export function parseOxlintFindings(stdout: string, exitCode: number, measuredRules: ReadonlySet<string>): readonly OxlintFinding[] {
  const groups = new Map<string, { path: string; rule: string; count: number; max?: number }>();
  for (const { path, code, message } of parseOxlintEnvelope(stdout, exitCode).entries) {
    const rule = code.replace("(", "/").slice(0, -1);
    const key = `${path}\u0000${rule}`;
    const group = groups.get(key) ?? { path, rule, count: 0 };
    group.count += 1;
    if (measuredRules.has(rule)) {
      const measured = /\((\d{1,15})\)/u.exec(message)?.[1];
      if (measured === undefined) { malformed(); }
      group.max = Math.max(group.max ?? 0, Number(measured));
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}
