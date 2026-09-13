// Extracted from the repository production guard: only literal pnpm calls and
// && sequences are supported. This deliberately is not a shell interpreter.
function sequence(command: string | undefined, expected: string): readonly string[] {
  if (typeof command !== "string") { return []; }
  const parts = command.split(/\s*&&\s*/u).map((part) => part.trim());
  return parts.every((part) => part === expected || /^(?:pnpm (?:run )?[\w:-]+|node scripts\/[\w./-]+\.mjs|false|true)$/u.test(part)) ? parts : [];
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
    const match = /^pnpm (?:run )?([\w:-]+)$/u.exec(part.trim());
    return match?.[1] !== undefined && containsFailure(scripts, match[1], visited);
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
    const match = /^pnpm (?:run )?([\w:-]+)$/u.exec(part);
    return match?.[1] !== undefined && containsScriptRoute(scripts, match[1], target, expected, visited);
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
