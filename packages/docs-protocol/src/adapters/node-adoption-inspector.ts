import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DOCS_ADOPTION_MAX_ROUTING_BYTES,
  DOCS_ADOPTION_MAX_SKILL_BYTES,
  type DocsAdoptionInspector,
  type DocsDiagnostic
} from "../domain/model.js";
import {
  assertContainedAuthority,
  readContainedText
} from "./adoption-input.js";

function diagnostic(subject: string, message: string): DocsDiagnostic {
  return { ruleId: "docs.adoption.invalid", severity: "error", phase: "authority", subject, message };
}

function inspectPortableSkill(source: string): readonly string[] {
  if (source.includes("\r") || source !== source.normalize("NFC") || !source.endsWith("\n")) {
    return ["Portable Skill must be NFC UTF-8 text with LF lines and one final newline."];
  }
  const lines = source.slice(0, -1).split("\n");
  const diagnostics: string[] = [];
  if (lines.length < 12 || lines.length > 80) {
    diagnostics.push("Portable Skill must contain between 12 and 80 lines.");
  }
  const declarations = source.match(/agent-teams\.docs-protocol\/v[0-9]+/gu) ?? [];
  if (declarations.length !== 1 || declarations[0] !== "agent-teams.docs-protocol/v1") {
    diagnostics.push("Portable Skill must declare exactly agent-teams.docs-protocol/v1.");
  }
  const evidence = [
    /docs-protocol find/u,
    /docs-protocol new.*--dry-run/u,
    /docs-protocol new.*--apply/u,
    /(?=.*manual-required)(?=.*markdownLink)(?=.*indexPath)/u,
    /docs-protocol context/u,
    /docs-protocol check/u
  ];
  let previous = -1;
  for (const marker of evidence) {
    const matches = lines.flatMap((line, index) => marker.test(line) ? [index] : []);
    if (matches.length !== 1 || matches[0]! <= previous) {
      diagnostics.push("Portable Skill must contain unique ordered find, preview, apply, manual reachability, context, and check steps.");
      break;
    }
    previous = matches[0]!;
  }
  return diagnostics;
}

function inspectAgentsRoute(source: string, skillPath: string): readonly string[] {
  const expected = `Use [${skillPath}](${skillPath}) for documentation.`;
  const occurrences = source.split(/\r?\n/u).filter((line) => line === expected).length;
  return occurrences === 1 ? [] : [`AGENTS.md must contain exactly one route: ${expected}`];
}

export class NodeDocsAdoptionInspector implements DocsAdoptionInspector {
  async inspect(input: Parameters<DocsAdoptionInspector["inspect"]>[0]): Promise<readonly DocsDiagnostic[]> {
    const diagnostics: DocsDiagnostic[] = [];
    let root = "";
    try { root = await realpath(resolve(input.consumerRoot)); } catch { return Object.freeze([diagnostic(input.consumerRoot, "Consumer root must be one accessible real directory.")]); }
    try {
      const agents = await readContainedText(root, "AGENTS.md", DOCS_ADOPTION_MAX_ROUTING_BYTES);
      diagnostics.push(...inspectAgentsRoute(agents, input.skillPath).map((message) => diagnostic("AGENTS.md", message)));
    } catch (error) { diagnostics.push(diagnostic("AGENTS.md", `AGENTS.md must be a bounded real file: ${error instanceof Error ? error.message : "invalid input"}`)); }
    try {
      const skill = await readContainedText(root, input.skillPath, DOCS_ADOPTION_MAX_SKILL_BYTES);
      diagnostics.push(...inspectPortableSkill(skill).map((message) => diagnostic(input.skillPath, message)));
    } catch (error) { diagnostics.push(diagnostic(input.skillPath, `Skill must be a bounded real file: ${error instanceof Error ? error.message : "invalid input"}`)); }
    for (const path of [input.profilePath, input.skillPath, ...input.authorityPaths]) {
      try { await assertContainedAuthority(root, path); } catch { diagnostics.push(diagnostic(path, "Declared documentation authority must be a bounded real contained regular file.")); }
    }
    return Object.freeze(diagnostics);
  }
}
