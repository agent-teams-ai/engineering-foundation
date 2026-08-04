import { parseSync, type Comment } from "oxc-parser";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import type { SourceFileSnapshot } from "../../../../../source-inventory/application/model/source-file-snapshot.js";
import type {
  SuppressionDirective,
  SuppressionDirectiveKind,
  SuppressionScan
} from "../../../application/model/suppression-governance.js";
import type { SuppressionScanner } from "../../../application/ports/suppression-scanner.js";

interface LocatedComment {
  readonly comment: Comment;
  readonly line: number;
  readonly column: number;
}

function lineStarts(source: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function locate(comment: Comment, starts: readonly number[]): LocatedComment {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = starts[middle];
    const next = starts[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (start === undefined) {
      break;
    }
    if (comment.start < start) {
      high = middle - 1;
    } else if (comment.start >= next) {
      low = middle + 1;
    } else {
      return { comment, line: middle + 1, column: comment.start - start + 1 };
    }
  }
  return { comment, line: 1, column: 1 };
}

function rules(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return [...new Set(value.split(/[\s,]+/u).filter((entry) => entry.length > 0))]
    .toSorted();
}

function directive(input: {
  readonly kind: SuppressionDirectiveKind;
  readonly file: SourceFileSnapshot;
  readonly location: LocatedComment;
  readonly rules?: readonly string[];
  readonly scope?: "file" | "line";
}): SuppressionDirective {
  return {
    kind: input.kind,
    path: input.file.path,
    line: input.location.line,
    column: input.location.column,
    rules: input.rules ?? [],
    scope: input.scope ?? "line"
  };
}

function parseComment(
  file: SourceFileSnapshot,
  location: LocatedComment,
  sourceLines: readonly string[]
): SuppressionDirective | undefined {
  const value = location.comment.value.trim();
  const lint = /^(oxlint|eslint)-(disable-next-line|disable-line|disable)(?:\s+(.+))?$/u.exec(
    value
  );
  if (lint !== null) {
    const tool = lint[1];
    const form = lint[2];
    if (tool === undefined || form === undefined) {
      return undefined;
    }
    return directive({
      file,
      location,
      kind: `${tool}-${form}` as SuppressionDirectiveKind,
      rules: rules(lint[3]),
      scope: form === "disable" ? "file" : "line"
    });
  }

  const typescript = /^@ts-(expect-error|ignore|nocheck)\b(?:\s*:?.*)?$/u.exec(value);
  if (typescript !== null) {
    const form = typescript[1];
    if (form === undefined) {
      return undefined;
    }
    return directive({
      file,
      location,
      kind: `typescript-${form}` as SuppressionDirectiveKind,
      rules: form === "expect-error" ? ["typescript/type-error"] : [],
      scope: form === "nocheck" ? "file" : "line"
    });
  }

  const astGrep = /^ast-grep-ignore(?:\s*:\s*(.*))?$/u.exec(value);
  if (astGrep === null) {
    return undefined;
  }
  const fileLevel =
    location.line === 1 && (sourceLines[1]?.trim().length ?? 0) === 0;
  return directive({
    file,
    location,
    kind: "ast-grep-ignore",
    rules: rules(astGrep[1]),
    scope: fileLevel ? "file" : "line"
  });
}

export class OxcSuppressionScanner implements SuppressionScanner {
  scan(file: SourceFileSnapshot): SuppressionScan {
    const parsed = parseSync(file.path, file.source, { astType: "ts" });
    if (parsed.errors.length > 0) {
      return { path: file.path, parseErrorCount: parsed.errors.length, directives: [] };
    }
    const starts = lineStarts(file.source);
    const sourceLines = file.source.split(/\r?\n/u);
    const directives = parsed.comments
      .map((comment) => parseComment(file, locate(comment, starts), sourceLines))
      .filter((candidate): candidate is SuppressionDirective => candidate !== undefined)
      .toSorted(
        (left, right) =>
          left.line - right.line ||
          left.column - right.column ||
          compareBinaryStrings(left.kind, right.kind)
      );
    return {
      path: file.path,
      parseErrorCount: 0,
      directives
    };
  }
}
