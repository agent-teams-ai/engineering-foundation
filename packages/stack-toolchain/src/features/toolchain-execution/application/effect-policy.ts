export const effectDiagnosticsContractVersion = 1;

export interface EffectCheckInput {
  readonly cwd: string;
  readonly projects: readonly string[];
  readonly signal: AbortSignal;
  readonly budgetMs?: number;
}
export type EffectCheckOutcome =
  | "passed"
  | "diagnostics"
  | "invalid-input"
  | "tool-unavailable"
  | "tool-incompatible"
  | "execution-failed"
  | "cancelled";
export interface EffectProjectResult {
  readonly project: string;
  readonly status: "passed" | "diagnostics" | "failed";
  readonly sourceFiles: readonly string[];
  readonly diagnosticCodes: readonly number[];
  readonly stdout: string;
  readonly stderr: string;
  readonly reason?: string;
}
export interface EffectToolVersions {
  readonly package: "@effect/tsgo-linux-x64";
  readonly version: "0.73.4";
  readonly typescript: "7.0.2";
  readonly binarySha256: string;
  readonly libraryCount: 108;
}
export interface EffectCheckReport {
  readonly schemaVersion: 1;
  readonly command: "effect:check";
  readonly status: "passed" | "failed";
  readonly exitCode: 0 | 1 | 2 | 130;
  readonly durationMs: number;
  readonly versions: EffectToolVersions | null;
  readonly details: {
    readonly outcome: EffectCheckOutcome;
    readonly selected: readonly string[];
    readonly projects: readonly EffectProjectResult[];
    readonly unattempted: readonly string[];
    readonly reason?: string;
    readonly stdout?: string;
    readonly stderr?: string;
  };
}

export class EffectCheckFailure extends Error {
  readonly outcome: EffectCheckOutcome;
  constructor(outcome: EffectCheckOutcome, reason: string) {
    super(reason);
    this.outcome = outcome;
  }
}
export function requireEffect(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new EffectCheckFailure("invalid-input", reason);
}
export function effectObject(value: unknown): Record<string, unknown> {
  requireEffect(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "EFFECT_CONFIG_OBJECT",
  );
  return value as Record<string, unknown>;
}

export function effectInputs(input: EffectCheckInput): Required<EffectCheckInput> {
  const value = effectObject(input);
  requireEffect(
    Object.keys(value).every((key) => ["cwd", "projects", "signal", "budgetMs"].includes(key)),
    "EFFECT_INPUT_FIELDS",
  );
  requireEffect(
    typeof input.cwd === "string" &&
      input.cwd.length > 0 &&
      input.cwd.length <= 4096 &&
      !/[\u0000-\u001f]/u.test(input.cwd),
    "EFFECT_ROOT",
  );
  requireEffect(input.signal instanceof AbortSignal, "EFFECT_SIGNAL");
  const budgetMs = input.budgetMs ?? 300_000;
  requireEffect(
    Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= 2_147_483_647,
    "EFFECT_BUDGET",
  );
  requireEffect(
    Array.isArray(input.projects) && input.projects.length > 0 && input.projects.length <= 64,
    "EFFECT_PROJECTS",
  );
  const projects = input.projects.map((project) => {
    requireEffect(
      typeof project === "string" && project.length <= 4096 && !/[\\:\u0000-\u001f]/u.test(project),
      "EFFECT_PROJECT_PATH",
    );
    const normalized = project.replace(/^\.\//u, "");
    requireEffect(
      /\.jsonc?$/u.test(normalized) &&
        !normalized.startsWith("-") &&
        normalized.split("/").every((part) => !["", ".", "..", "node_modules"].includes(part)),
      "EFFECT_PROJECT_PATH",
    );
    return normalized;
  });
  requireEffect(new Set(projects).size === projects.length, "EFFECT_PROJECT_DUPLICATE");
  return { cwd: input.cwd, projects, signal: input.signal, budgetMs };
}

export function validateEffectPolicy(value: unknown): void {
  const config = effectObject(value);
  requireEffect(!Object.hasOwn(config, "references"), "EFFECT_PROJECT_REFERENCES");
  const plugins = effectObject(config["compilerOptions"])["plugins"];
  requireEffect(Array.isArray(plugins) && plugins.length === 1, "EFFECT_POLICY_PLUGIN");
  const plugin = effectObject(plugins[0]);
  const fields = [
    "name",
    "diagnostics",
    "diagnosticSeverity",
    "allowedUnstableApis",
    "ignoreEffectWarningsInTscExitCode",
    "ignoreEffectErrorsInTscExitCode",
    "includeSuggestionsInTsc",
  ];
  requireEffect(
    Object.keys(plugin).length === fields.length &&
      Object.keys(plugin).every((key) => fields.includes(key)),
    "EFFECT_POLICY_FIELDS",
  );
  requireEffect(
    plugin["name"] === "@effect/language-service" &&
      plugin["diagnostics"] === true &&
      plugin["ignoreEffectWarningsInTscExitCode"] === false &&
      plugin["ignoreEffectErrorsInTscExitCode"] === false &&
      plugin["includeSuggestionsInTsc"] === false,
    "EFFECT_POLICY_DISABLED",
  );
  const severity = effectObject(plugin["diagnosticSeverity"]);
  requireEffect(
    Object.keys(severity).length === 2 &&
      severity["unstableApiUsage"] === "error" &&
      severity["apiStabilityLeak"] === "error",
    "EFFECT_POLICY_SEVERITY",
  );
  const allowed = plugin["allowedUnstableApis"];
  requireEffect(
    Array.isArray(allowed) &&
      allowed.length <= 256 &&
      allowed.every(
        (item: unknown) =>
          typeof item === "string" &&
          item.length <= 512 &&
          /^[A-Za-z0-9@_./-]+#[A-Za-z_$][A-Za-z0-9_$]*$/u.test(item) &&
          !item.split("/").some((part) => ["", ".", ".."].includes(part)),
      ) &&
      new Set(allowed).size === allowed.length,
    "EFFECT_POLICY_ALLOWLIST",
  );
}

export function validateEffectConfiguration(value: unknown): readonly string[] {
  const config = effectObject(value);
  const options = effectObject(config["compilerOptions"]);
  const strict = [
    "alwaysStrict",
    "noImplicitAny",
    "noImplicitThis",
    "strictBindCallApply",
    "strictBuiltinIteratorReturn",
    "strictFunctionTypes",
    "strictNullChecks",
    "strictPropertyInitialization",
    "useUnknownInCatchVariables",
  ];
  requireEffect(
    options["strict"] === true &&
      options["noEmit"] === true &&
      strict.every((key) => options[key] !== false),
    "EFFECT_TYPESCRIPT_STRICT",
  );
  requireEffect(
    options["noCheck"] !== true &&
      options["skipLibCheck"] !== true &&
      options["skipDefaultLibCheck"] !== true &&
      options["allowJs"] !== true &&
      !Object.hasOwn(config, "references"),
    "EFFECT_TYPESCRIPT_SCOPE",
  );
  const files = config["files"];
  requireEffect(
    Array.isArray(files) &&
      files.length > 0 &&
      files.length <= 50_000 &&
      files.every(
        (file: unknown) =>
          typeof file === "string" &&
          file.length > 0 &&
          file.length <= 4096 &&
          !/[\u0000-\u001f]/u.test(file),
      ),
    "EFFECT_TYPESCRIPT_FILES",
  );
  return files as string[];
}

export function classifyEffectOutput(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}): { readonly status: "passed" | "diagnostics"; readonly diagnosticCodes: readonly number[] } {
  if (result.signal !== null || result.stderr !== "")
    throw new EffectCheckFailure("execution-failed", "EFFECT_EXECUTION_OUTPUT");
  if (result.exitCode === 0 && result.stdout.trim() === "")
    return { status: "passed", diagnosticCodes: [] };
  const codes: number[] = [];
  for (const line of result.stdout.split(/\r?\n/u).filter((part) => part.trim() !== "")) {
    const diagnostic = /^(?:.+\(\d+,\d+\): )?(?:error|warning) TS(\d{4,6}): .+/u.exec(line);
    if (diagnostic !== null) codes.push(Number(diagnostic[1]));
    else throw new EffectCheckFailure("execution-failed", "EFFECT_EXECUTION_OUTPUT");
  }
  if (![1, 2].includes(result.exitCode ?? -1) || codes.length === 0)
    throw new EffectCheckFailure("execution-failed", "EFFECT_EXECUTION_OUTPUT");
  return { status: "diagnostics", diagnosticCodes: [...new Set(codes)].sort((a, b) => a - b) };
}
