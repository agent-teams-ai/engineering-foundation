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
export function requireEffect(condition: boolean, reason: string): asserts condition {
  if (!condition) {
    throw new EffectCheckFailure("invalid-input", reason);
  }
}
export function effectObject(value: unknown): Record<string, unknown> {
  requireEffect(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "EFFECT_CONFIG_OBJECT",
  );
  return value as Record<string, unknown>;
}

export function effectHasControls(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
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
      !effectHasControls(input.cwd),
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
      typeof project === "string" &&
        project.length <= 4096 &&
        !/[\\:]/u.test(project) &&
        !effectHasControls(project),
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
          !effectHasControls(file),
      ),
    "EFFECT_TYPESCRIPT_FILES",
  );
  return files as string[];
}

// Native 7.0.2 prints message-chain children with two spaces per depth:
// microsoft/typescript-go@2bd066d87f5bafd315be9f40889d0a60b9e58e0b,
// internal/diagnosticwriter/diagnosticwriter.go, flattenDiagnosticMessageChain.
// Admit these English message families only. Quoted fields cannot contain a
// quote/newline; unfamiliar messages retain their raw output as execution failures.
const effectChainMessages = [
  /^(?:Type '[^']+' is not assignable to type|Argument of type '[^']+' is not assignable to parameter of type) '[^']+'\.$/u,
  /^The types (?:of|returned by) '[^']+' are incompatible between these types\.$/u,
  /^Types of (?:property '[^']+'|parameters '[^']+' and '[^']+') are incompatible\.$/u,
  /^Property '[^']+' is missing in type '[^']+'(?: but required in type '[^']+')?\.$/u,
  /^Type '[^']+' provides no match for the signature '[^']+'\.$/u,
  /^(?:Index signature for type '[^']+' is missing in type '[^']+'|'[^']+'(?: and '[^']+')? index signatures are incompatible)\.$/u,
  /^(?:Overload [1-9]\d* of [1-9]\d*, '[^']+', gave the following error|Target signature provides too few arguments\. Expected \d+ or more, but got \d+|Call signature return types '[^']+' and '[^']+' are incompatible)\.$/u,
];

function effectContinuationDepth(line: string, previousDepth: number): number | null {
  const continuation = /^( {2,64})(\S.*)$/u.exec(line);
  if (continuation === null) {
    return null;
  }
  const depth = continuation[1]!.length / 2;
  if (
    !Number.isInteger(depth) ||
    depth > previousDepth + 1 ||
    !effectChainMessages.some((message) => message.test(continuation[2]!))
  ) {
    return null;
  }
  return depth;
}

export function classifyEffectOutput(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}): { readonly status: "passed" | "diagnostics"; readonly diagnosticCodes: readonly number[] } {
  if (result.signal !== null || result.stderr !== "") {
    throw new EffectCheckFailure("execution-failed", "EFFECT_EXECUTION_OUTPUT");
  }
  if (result.exitCode === 0 && result.stdout.trim() === "") {
    return { status: "passed", diagnosticCodes: [] };
  }
  const codes: number[] = [];
  let chainAllowed = false;
  let depth = 0;
  let continuationCount = 0;
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line === "") {
      chainAllowed = false;
      continue;
    }
    if (line.length > 8192 || effectHasControls(line)) {
      throw new EffectCheckFailure("execution-failed", "EFFECT_EXECUTION_OUTPUT");
    }
    const diagnostic = /^(?:.+\(\d+,\d+\): )?(?:error|warning) TS(\d{4,6}): .+/u.exec(line);
    if (diagnostic !== null) {
      const code = Number(diagnostic[1]);
      codes.push(code);
      chainAllowed = code < 100_000;
      depth = 0;
      continuationCount = 0;
      continue;
    }
    const nextDepth = effectContinuationDepth(line, depth);
    if (!chainAllowed || nextDepth === null || ++continuationCount > 128) {
      throw new EffectCheckFailure("execution-failed", "EFFECT_EXECUTION_OUTPUT");
    }
    depth = nextDepth;
  }
  if (![1, 2].includes(result.exitCode ?? -1) || codes.length === 0) {
    throw new EffectCheckFailure("execution-failed", "EFFECT_EXECUTION_OUTPUT");
  }
  return { status: "diagnostics", diagnosticCodes: [...new Set(codes)].toSorted((a, b) => a - b) };
}
