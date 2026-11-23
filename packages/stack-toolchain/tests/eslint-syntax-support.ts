import assert from "node:assert/strict";
import { Linter } from "eslint";
import { parser, plugin } from "../dist/eslint-syntax.js";

export function ruleConfig(rule: string, options: readonly unknown[] = []): Linter.Config {
  return {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    languageOptions: { parser, sourceType: "module" },
    plugins: { "@typescript-eslint": plugin },
    rules: { [`@typescript-eslint/${rule}`]: ["error", ...options] },
  };
}

export function lint(rule: string, code: string, options: readonly unknown[] = [], filename = "fixture.ts"): Linter.LintMessage[] {
  return new Linter().verify(code, [ruleConfig(rule, options)], { filename });
}

export function applyEdit(code: string, fix: NonNullable<Linter.LintMessage["fix"]>): string {
  return code.slice(0, fix.range[0]) + fix.text + code.slice(fix.range[1]);
}

interface Span { line: number; column: number; endLine: number; endColumn: number }

function position(prefix: string): { line: number; column: number } {
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/** Marked spans are independent fixture expectations, never extracted from diagnostics. */
export function markedSource(marked: string): { code: string; spans: Span[] } {
  let code = "";
  let cursor = 0;
  const spans: Span[] = [];
  for (const match of marked.matchAll(/«([^»]*)»/gu)) {
    const content = match[1];
    assert.notEqual(content, undefined);
    code += marked.slice(cursor, match.index);
    const start = position(code);
    code += content;
    const end = position(code);
    spans.push({ ...start, endLine: end.line, endColumn: end.column });
    cursor = match.index + match[0].length;
  }
  code += marked.slice(cursor);
  return { code, spans };
}

export function expectReports(rule: string, marked: string, messageIds: readonly string[], options: readonly unknown[] = [], filename = "fixture.ts"): Linter.LintMessage[] {
  const { code, spans } = markedSource(marked);
  assert.equal(spans.length, messageIds.length, "Every expected report must identify a source span.");
  const messages = lint(rule, code, options, filename);
  assert.deepEqual(messages.map(({ ruleId, messageId, severity, line, column, endLine, endColumn, fatal }) => ({
    ruleId, messageId, severity, line, column, endLine, endColumn, fatal: fatal ?? false,
  })), spans.map((span, index) => ({
    ruleId: `@typescript-eslint/${rule}`, messageId: messageIds[index], severity: 2, ...span, fatal: false,
  })));
  return messages;
}
