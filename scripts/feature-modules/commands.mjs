// This repository adopts only literal pnpm script calls joined by &&. A failed
// prerequisite stays failed. Shell branching/quoting/evaluation needs a separate
// reviewed contract, not an interpreter in the architecture guard.
export const productionGates = [
  ["lint:typed", "node scripts/check-production-quality.mjs typed"],
  ["architecture:patterns", "node scripts/run-ast-grep.mjs scan --config sgconfig.yml --error=unused-suppression"]
];
function sequence(command, expected) {
  if (typeof command !== "string") {return [];}
  const parts = command.split(/\s*&&\s*/u);
  return parts.every((part) => part.trim() === expected || /^(?:pnpm (?:run )?[\w:-]+|node scripts\/[\w./-]+\.mjs|false|true)$/u.test(part.trim()))
    ? parts.map((part) => part.trim()) : [];
}
export function executesScript(scripts, entry, target, expected, active = new Set()) {
  if (active.has(entry)) {return false;}
  const parts = sequence(scripts?.[entry], expected);
  if (!parts.length) {return false;}
  if (entry === target) {return parts.includes(expected);}
  const visited = new Set([...active, entry]);
  return parts.some((part) => {
    const match = /^pnpm (?:run )?([\w:-]+)$/u.exec(part);
    return match && executesScript(scripts, match[1], target, expected, visited);
  });
}
