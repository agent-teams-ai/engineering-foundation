import fs from "node:fs";
import path from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { createProcessExecutor } from "node-or-bun";
import { createNodeProcessAdapter } from "node-or-bun/node";
import { resolveCompilerExecutable } from "./executables.js";

export interface LintScope {
  readonly config: string;
  readonly paths: readonly string[];
}
export interface ToolchainConfiguration {
  readonly root: string;
  readonly profile: "typescript-node" | "typescript-bun";
  readonly projects: readonly string[];
  readonly lint: LintScope & {
    readonly backend?: "oxlint" | "bun-experimental";
    readonly syntax?: LintScope;
  };
  readonly format: { readonly paths: readonly string[] };
}
function object(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("TOOLCHAIN_CONFIG_OBJECT");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !fields.includes(key) && !optional.includes(key)) ||
    fields.some((key) => !(key in record))
  ) {
    throw new Error("TOOLCHAIN_CONFIG_FIELDS");
  }
  return record;
}
function relative(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("-") ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").includes("..")
  ) {
    throw new Error("TOOLCHAIN_CONFIG_PATH");
  }
  return value;
}
function paths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("TOOLCHAIN_CONFIG_EMPTY");
  }
  const result = value.map(relative);
  if (new Set(result.map((item) => path.normalize(item))).size !== result.length) {
    throw new Error("TOOLCHAIN_CONFIG_DUPLICATE");
  }
  return result;
}
function assertBunLintEntry(key: string, value: unknown, ruleOptions: boolean): void {
  if (
    /^(?:vue|jsdoc)\//u.test(key) ||
    (key === "plugins" &&
      Array.isArray(value) &&
      value.some((plugin) => plugin === "vue" || plugin === "jsdoc"))
  ) {
    throw new Error("TOOLCHAIN_BUN_LINT_PLUGIN_UNSUPPORTED");
  }
  if (ruleOptions && /pattern|regex/iu.test(key)) {
    throw new Error("TOOLCHAIN_BUN_LINT_PATTERN_OPTIONS_UNSUPPORTED");
  }
  if (
    (key === "files" || key === "excludeFiles") &&
    Array.isArray(value) &&
    value.some((pattern) => typeof pattern === "string" && /[?*+@!]\(/u.test(pattern))
  ) {
    throw new Error("TOOLCHAIN_BUN_LINT_EXTGLOB_UNSUPPORTED");
  }
}
function lintBackend(value: unknown): ToolchainConfiguration["lint"]["backend"] {
  if (value !== undefined && value !== "oxlint" && value !== "bun-experimental") {
    throw new Error("TOOLCHAIN_LINT_BACKEND_UNSUPPORTED");
  }
  return value;
}
function assertBunLintOption(value: unknown, ruleOptions: boolean): void {
  if (ruleOptions && typeof value === "string" && !["off", "warn", "error"].includes(value)) {
    throw new Error("TOOLCHAIN_BUN_LINT_RULE_OPTIONS_UNSUPPORTED");
  }
}
function lintRuleMap(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TOOLCHAIN_LINT_CONFIG_RULES");
  }
  return value as Record<string, unknown>;
}
function validateLintConfiguration(
  filename: string,
  syntaxOnly: boolean,
  experimentalBun = false,
  seen = new Set<string>(),
  active = new Set<string>(),
): void {
  const lexical = path.resolve(filename);
  const canonical = fs.realpathSync(filename);
  if (active.has(canonical) || seen.size >= 32 || !/\.jsonc?$/u.test(canonical)) {
    throw new Error("TOOLCHAIN_LINT_CONFIG_EXECUTABLE_OR_CYCLE");
  }
  if (seen.has(lexical)) {
    return;
  }
  seen.add(lexical);
  active.add(canonical);
  const source = fs.readFileSync(canonical, "utf8");
  if (source.length > 1_000_000) {
    throw new Error("TOOLCHAIN_LINT_CONFIG_LIMIT");
  }
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error("TOOLCHAIN_LINT_CONFIG_JSON");
  }
  const inspectRules = (rules: Record<string, unknown>): void => {
    for (const [rule, options] of Object.entries(rules)) {
      if (experimentalBun) {
        assertBunLintEntry(rule, options, false);
      }
      inspect(options, true);
    }
  };
  const inspect = (item: unknown, ruleOptions = false): void => {
    if (experimentalBun) {
      assertBunLintOption(item, ruleOptions);
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        inspect(child, ruleOptions);
      }
      return;
    }
    if (item === null || typeof item !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (experimentalBun) {
        assertBunLintEntry(key, child, ruleOptions);
      }
      if (key === "typeCheck" && child === true) {
        throw new Error("TOOLCHAIN_LINT_SEMANTIC_CHECK_UNSUPPORTED");
      }
      if (syntaxOnly && key === "typeAware" && child === true) {
        throw new Error("TOOLCHAIN_SYNTAX_LINT_TYPE_AWARE");
      }
      if (key === "jsPlugins") {
        throw new Error("TOOLCHAIN_LINT_CONFIG_EXECUTABLE");
      }
      if (key === "extends") {
        if (
          !Array.isArray(child) ||
          child.some((entry) => typeof entry !== "string" || !entry.startsWith("."))
        ) {
          throw new Error("TOOLCHAIN_LINT_CONFIG_EXTENDS");
        }
        for (const entry of child as string[]) {
          validateLintConfiguration(
            path.resolve(path.dirname(lexical), entry),
            syntaxOnly,
            experimentalBun,
            seen,
            active,
          );
        }
      } else {
        if (key === "rules") {
          inspectRules(lintRuleMap(child));
        } else {
          inspect(child, ruleOptions);
        }
      }
    }
  };
  inspect(value);
  active.delete(canonical);
}
function lintScope(
  root: string,
  value: unknown,
  syntaxOnly: boolean,
  experimentalBun: boolean,
): LintScope {
  const scope = object(value, ["config", "paths"]);
  const config = path.resolve(root, relative(scope["config"]));
  if (!fs.statSync(config).isFile()) {
    throw new Error("TOOLCHAIN_LINT_CONFIG_MISSING");
  }
  validateLintConfiguration(config, syntaxOnly, experimentalBun);
  return { config, paths: paths(scope["paths"]) };
}
export async function loadConfiguration(input: {
  readonly cwd: string;
  readonly configPath?: string;
  readonly signal?: AbortSignal;
}): Promise<ToolchainConfiguration> {
  const root = path.resolve(input.cwd);
  const filename = path.resolve(root, relative(input.configPath ?? "toolchain.config.json"));
  const config = object(JSON.parse(fs.readFileSync(filename, "utf8")) as unknown, [
    "schemaVersion",
    "profile",
    "typecheck",
    "lint",
    "format",
  ]);
  if (
    config["schemaVersion"] !== 1 ||
    !["typescript-node", "typescript-bun"].includes(String(config["profile"]))
  ) {
    throw new Error("TOOLCHAIN_CONFIG_PROFILE");
  }
  const typecheck = object(config["typecheck"], ["projects"]);
  const lint = object(config["lint"], ["config", "paths"], ["syntax", "backend"]);
  const backend = lintBackend(lint["backend"]);
  const format = object(config["format"], ["paths"]);
  const projects = paths(typecheck["projects"]).map((item) => path.resolve(root, item));
  for (const project of projects) {
    const executable = resolveCompilerExecutable();
    const result = await createProcessExecutor(createNodeProcessAdapter()).run({
      command: executable.command,
      args: [...executable.prefix, "--showConfig", "--project", project],
      cwd: root,
      timeoutMs: 30_000,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      strictUtf8: true,
    });
    if (
      result.exitCode !== 0 ||
      !result.facts.outputBounded ||
      result.facts.incompleteCustody ||
      result.facts.lateFailureCodes.length
    ) {
      throw new Error("TOOLCHAIN_CONFIG_PARSE_FAILED");
    }
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const options = parsed["compilerOptions"] as Record<string, unknown> | undefined;
    if (options?.["noCheck"] === true) {
      throw new Error("TOOLCHAIN_NOCHECK_UNSUPPORTED");
    }
    if ("references" in parsed) {
      throw new Error("TOOLCHAIN_PROJECT_REFERENCES_UNSUPPORTED");
    }
    if (!Array.isArray(parsed["files"]) || parsed["files"].length === 0) {
      throw new Error("TOOLCHAIN_CONFIG_EMPTY_INPUTS");
    }
  }
  const experimentalBun = backend === "bun-experimental";
  const typed = lintScope(
    root,
    { config: lint["config"], paths: lint["paths"] },
    false,
    experimentalBun,
  );
  const syntax = Object.hasOwn(lint, "syntax")
    ? lintScope(root, lint["syntax"], true, experimentalBun)
    : undefined;
  return {
    root,
    profile: config["profile"] as ToolchainConfiguration["profile"],
    projects,
    lint: {
      ...typed,
      ...(backend === undefined ? {} : { backend }),
      ...(syntax === undefined ? {} : { syntax }),
    },
    format: { paths: paths(format["paths"]) },
  };
}
