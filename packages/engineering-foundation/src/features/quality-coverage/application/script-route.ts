// Extracted from the repository production guard: only literal manager calls,
// repository-command routes and && sequences are supported. This deliberately
// is not a shell interpreter.
function sequence(command: string | undefined, expected: string): readonly string[] {
  if (typeof command !== "string") { return []; }
  const parts = command.split(/\s*&&\s*/u).map((part) => part.trim());
  return parts.every((part) =>
    part === expected ||
    /^(?:pnpm (?:run )?[\w:-]+|node scripts\/[\w./-]+\.(?:mjs|mts)|node tools\/repository-command\.mts (?:script|tool) [\w:.-]+|false|true)$/u.test(part)
  ) ? parts : [];
}

// A literal failure anywhere in the required chain cannot establish a valid
// successful gate. Inspect nested literal calls without interpreting shell code.
function containsFailure(
  scripts: Readonly<Record<string, string>> | undefined,
  entry: string,
  active: ReadonlySet<string> = new Set()
): boolean {
  if (active.has(entry) || active.size >= 128) { return true; }
  const visited = new Set([...active, entry]);
  return (scripts?.[entry] ?? "").split(/\s*&&\s*/u).some((part) => {
    if (part.trim() === "false") { return true; }
    const match = /^(?:pnpm (?:run )?([\w:-]+)|node tools\/repository-command\.mts script ([A-Za-z0-9][A-Za-z0-9:._-]*))$/u.exec(part.trim());
    const script = match?.[1] ?? match?.[2];
    return script !== undefined && containsFailure(scripts, script, visited);
  });
}

export function containsScriptRoute(
  scripts: Readonly<Record<string, string>> | undefined,
  entry: string,
  target: string,
  expected: string,
  active: ReadonlySet<string> = new Set()
): boolean {
  if (active.has(entry) || active.size >= 128) { return false; }
  const parts = sequence(scripts?.[entry], expected);
  if (parts.length === 0) { return false; }
  if (entry === target) { return parts.includes(expected); }
  const visited = new Set([...active, entry]);
  return parts.some((part) => {
    const match = /^(?:pnpm (?:run )?([\w:-]+)|node tools\/repository-command\.mts script ([A-Za-z0-9][A-Za-z0-9:._-]*))$/u.exec(part);
    const script = match?.[1] ?? match?.[2];
    return script !== undefined && containsScriptRoute(scripts, script, target, expected, visited);
  });
}

// Quality coverage additionally requires a route without a literal failure.
export function executesScript(
  scripts: Readonly<Record<string, string>> | undefined,
  entry: string,
  target: string,
  expected: string
): boolean {
  return !containsFailure(scripts, entry) && containsScriptRoute(scripts, entry, target, expected);
}
