import { qualityDiagnostic } from "../api.js";

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

/** The exit status and JSON envelope must agree; a tool failure is never a lint finding. */
export function parseOxlintDiagnostics(stdout: string, exitCode: number): {
  readonly files: number;
  readonly diagnostics: readonly ReturnType<typeof qualityDiagnostic>[];
} {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { malformed(); }
  if (!record(value) || !Array.isArray(value["diagnostics"]) ||
    typeof value["number_of_files"] !== "number" || !Number.isSafeInteger(value["number_of_files"]) ||
    value["number_of_files"] < 1 || ![0, 1].includes(exitCode)) { malformed(); }
  const diagnostics = value["diagnostics"].map((input: unknown) => {
    if (!record(input) || typeof input["filename"] !== "string" ||
      typeof input["code"] !== "string" || !/^[a-z][a-z-]*\([a-z][a-z0-9-]*\)$/u.test(input["code"]) ||
      (input["severity"] !== "error" && input["severity"] !== "warning")) { malformed(); }
    const path = normalizeSelectedPath(input["filename"]);
    const diagnostic = qualityDiagnostic("lint-violation", path, `${path}:${input["code"]}`, "no lint violations", input["code"]);
    return { ...diagnostic, evidence: [...diagnostic.evidence, { kind: "tool-rule", value: input["code"] }] };
  });
  if ((exitCode === 0) !== (diagnostics.length === 0)) { malformed(); }
  return { files: value["number_of_files"], diagnostics };
}
