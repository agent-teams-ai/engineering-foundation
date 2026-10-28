import {
  isStaticRepositoryScriptPath,
  parseStaticHostCommand,
} from "../../configuration-input/application/static-host-command.js";

function scriptTarget(command: string): string | undefined {
  const manager = /^pnpm (?:run )?([\w:-]+)$/u.exec(command)?.[1];
  if (manager !== undefined) {
    return manager;
  }
  const host = parseStaticHostCommand(command);
  return host !== undefined &&
    host.arguments.length === 2 &&
    (host.arguments[0] === "run" || host.arguments[0] === "script") &&
    /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(host.arguments[1] ?? "")
    ? host.arguments[1]
    : undefined;
}

// Literal declaration traversal, not a shell interpreter or execution proof.
function sequence(command: string | undefined, expected: string): readonly string[] {
  if (command === undefined || /[\r\n]|\|\|/u.test(command)) {
    return [];
  }
  const parts = command.split(/\s*&&\s*/u).map((part) => part.trim());
  return parts.every(
    (part) =>
      part === expected ||
      scriptTarget(part) !== undefined ||
      nativeScriptEntrypoint(part) !== undefined ||
      part === "false" ||
      part === "true",
  )
    ? parts
    : [];
}

export function qualityHostCommand(
  command: string | undefined,
  scopeOnly: boolean,
  mode: "check" | "format" = "check",
): boolean {
  const host = parseStaticHostCommand(command);
  const expected = [
    "tool",
    "agent-teams-foundation",
    "quality",
    mode,
    "--consumer",
    ".",
    ...(scopeOnly ? ["--scope-only"] : []),
  ];
  return (
    host !== undefined &&
    host.arguments.length === expected.length &&
    expected.every((token, index) => host.arguments[index] === token)
  );
}

// Select a contained file to read; this never authenticates its implementation.
export function nativeScriptEntrypoint(command: string | undefined): string | undefined {
  const direct = /^node (scripts\/[\w./-]+\.(?:mjs|mts|ts))$/u.exec(command ?? "")?.[1];
  if (direct !== undefined) {
    return direct;
  }
  const host = parseStaticHostCommand(command);
  return host !== undefined &&
    host.arguments.length === 2 &&
    host.arguments[0] === "tool" &&
    (/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(host.arguments[1] ?? "") ||
      isStaticRepositoryScriptPath(host.arguments[1] ?? ""))
    ? host.entrypoint
    : undefined;
}

function containsFailure(
  scripts: Readonly<Record<string, string>> | undefined,
  entry: string,
  active: ReadonlySet<string> = new Set(),
): boolean {
  if (active.has(entry) || active.size >= 128 || scripts?.[entry] === undefined) {
    return true;
  }
  const visited = new Set([...active, entry]);
  const command = scripts[entry];
  if (/[\r\n]|\|\|/u.test(command)) {
    return true;
  }
  return command.split(/\s*&&\s*/u).some((part) => {
    if (part.trim() === "false") {
      return true;
    }
    const target = scriptTarget(part.trim());
    return target !== undefined && containsFailure(scripts, target, visited);
  });
}

export function containsScriptRoute(
  scripts: Readonly<Record<string, string>> | undefined,
  entry: string,
  target: string,
  expected: string,
  context: { readonly active: ReadonlySet<string>; readonly assetTarget: boolean } = {
    active: new Set(),
    assetTarget: false,
  },
): boolean {
  const { active, assetTarget } = context;
  if (active.has(entry) || active.size >= 128) {
    return false;
  }
  if (assetTarget && entry === target) {
    return assetValidatorDeclaration(scripts?.[entry]) !== undefined;
  }
  const parts = sequence(scripts?.[entry], expected);
  if (parts.length === 0) {
    return false;
  }
  if (entry === target) {
    return parts.includes(expected);
  }
  const visited = new Set([...active, entry]);
  return parts.some((part) => {
    const script = scriptTarget(part);
    return (
      script !== undefined &&
      containsScriptRoute(scripts, script, target, expected, { active: visited, assetTarget })
    );
  });
}

export function executesScript(
  scripts: Readonly<Record<string, string>> | undefined,
  entry: string,
  target: string,
  expected: string,
): boolean {
  return !containsFailure(scripts, entry) && containsScriptRoute(scripts, entry, target, expected);
}

/** A named validator declaration; actual validator behavior remains consumer-owned. */
export function assetValidatorDeclaration(
  command: string | undefined,
): readonly string[] | undefined {
  if (command === undefined || /[\r\n;|<>`$]/u.test(command)) {
    return undefined;
  }
  const paths: string[] = [];
  let validator = false;
  for (const part of command.split(/\s*&&\s*/u)) {
    const host = parseStaticHostCommand(part);
    if (host !== undefined) {
      paths.push(host.entrypoint);
      validator = true;
    } else if (/^buf (?:build|lint|format --diff --exit-code)$/u.test(part)) {
      validator = true;
    } else if (!/^tsc --project [A-Za-z0-9_./-]+\.json --noEmit$/u.test(part)) {
      return undefined;
    }
  }
  return validator ? paths : undefined;
}

export function executesAssetValidator(
  scripts: Readonly<Record<string, string>>,
  entry: string,
  target: string,
): boolean {
  if (assetValidatorDeclaration(scripts[target]) === undefined) {
    return false;
  }
  return (
    !containsFailure(scripts, entry) &&
    containsScriptRoute(scripts, entry, target, "", { active: new Set(), assetTarget: true })
  );
}
