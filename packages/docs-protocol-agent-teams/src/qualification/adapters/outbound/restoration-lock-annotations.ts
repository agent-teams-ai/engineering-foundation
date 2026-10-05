import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import type { JsonValue } from '../../application/model/restoration-lock-inputs.js';

type Path = readonly (string | number)[];
type Role = 'document' | 'key' | 'value';
type Widths = ReadonlyMap<string, ReadonlyMap<string, number>>;
interface Cursor {
  readonly parent: Cursor | undefined;
  readonly segment: string | number;
  readonly bytes: number;
  readonly mappedBytes: number;
}
interface Annotations {
  readonly comments: Record<string, JsonValue>;
  readonly spelling: Record<string, JsonValue>;
}
const annotationPathBudget = 8 * 1024 * 1024;
const roleBytes: Readonly<Record<Role, number>> = { document: 10, key: 5, value: 7 };

/** Exact UTF-8 width of JSON.stringify(value), without constructing that string. */
function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {bytes += 2;}
    else if (code < 0x20) {
      bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    } else if (code < 0x80) {bytes++;}
    else if (code < 0x800) {bytes += 2;}
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {bytes += 4; index++;}
      else {bytes += 6;}
    } else {bytes += code >= 0xdc00 && code <= 0xdfff ? 6 : 3;}
  }
  return bytes;
}

/** Private annotation collector; neither document supplies an expected graph. */
export function collectRestorationLockAnnotations(
  sourceBytes: readonly number[], actualBytes: readonly number[],
  protectedPath: (path: Path) => boolean, rename: ReadonlyMap<string, string>,
  need: (value: unknown, message: string) => asserts value,
): { source: Annotations; actual: Annotations } {
  let remaining = annotationPathBudget;
  function reserve(bytes: number): void {
    need(bytes <= remaining, 'annotation path expansion budget exceeded');
    remaining -= bytes;
  }
  function mappedWidths(): Widths {
    const result = new Map<string, Map<string, number>>();
    for (const [owner, replacement] of rename) {
      const cut = owner.indexOf('/');
      need(cut > 0, 'annotation owner mapping');
      const section = owner.slice(0, cut), id = owner.slice(cut + 1);
      const entries = result.get(section) ?? new Map<string, number>();
      entries.set(id, jsonStringBytes(replacement)); result.set(section, entries);
    }
    return result;
  }

  function preflight(document: Document, widths: Widths): void {
    function child(parent: Cursor | undefined, segment: string | number): Cursor {
      const width = typeof segment === 'string' ? jsonStringBytes(segment) : String(segment).length;
      const comma = parent === undefined ? 0 : 1;
      let mappedWidth = width;
      if (parent !== undefined && parent.parent === undefined &&
        typeof parent.segment === 'string' && typeof segment === 'string') {
        mappedWidth = widths.get(parent.segment)?.get(segment) ?? width;
      }
      return { parent, segment, bytes: (parent?.bytes ?? 2) + comma + width,
        mappedBytes: (parent?.mappedBytes ?? 2) + comma + mappedWidth };
    }
    function comments(row: { commentBefore?: string | null; comment?: string | null },
      bytes: number, role: Role): void {
      for (const slot of ['commentBefore', 'comment'] as const) {
        if (typeof row[slot] === 'string') {
          // Namespace text and JSON punctuation contribute 14 bytes.
          reserve(14 + roleBytes[role] + bytes + (slot === 'commentBefore' ? 15 : 9));
        }
      }
    }
    function visit(node: unknown, cursor: Cursor | undefined, role: Role): void {
      if (!isMap(node) && !isSeq(node) && !isScalar(node)) {return;}
      const bytes = cursor?.bytes ?? 2;
      // Charge every semantic node path and its potential spelling address.
      // Charging unprotected nodes keeps preflight independent of path arrays.
      reserve(bytes + 14 + roleBytes[role] + bytes);
      comments(node, cursor?.mappedBytes ?? 2, role);
      if (isMap(node)) {for (const pair of node.items) {
        need(isScalar(pair.key) && typeof pair.key.value === 'string', 'annotation key');
        const next = child(cursor, pair.key.value);
        visit(pair.key, next, 'key'); visit(pair.value, next, 'value');
      }}
      if (isSeq(node)) {
        for (let index = 0; index < node.items.length; index++) {
          visit(node.items[index], child(cursor, index), 'value');
        }
      }
    }
    reserve(2); comments(document, 2, 'document');
    visit(document.contents, undefined, 'value');
  }

  function materialize(document: Document, text: string,
    replacements: ReadonlyMap<string, string>): Annotations {
    const comments: Record<string, JsonValue> = {}, spelling: Record<string, JsonValue> = {};
    function mapped(path: Path): Path {
      const [section, id] = path;
      const replacement = typeof section === 'string' && typeof id === 'string'
        ? replacements.get(section + '/' + id) : undefined;
      return replacement === undefined ? path : [section ?? '', replacement, ...path.slice(2)];
    }
    function comment(row: { commentBefore?: string | null; comment?: string | null },
      path: Path, role: Role): void {
      for (const slot of ['commentBefore', 'comment'] as const) {
        const value = row[slot];
        if (typeof value === 'string') {
          comments[JSON.stringify(['comment', role, mapped(path), slot])] = value;
        }
      }
    }
    function visit(node: unknown, path: Path, role: Role): void {
      if (!isMap(node) && !isSeq(node) && !isScalar(node)) {return;}
      comment(node, path, role);
      if (protectedPath(path)) {
        const authValue = isScalar(node) && node.range ? text.slice(node.range[0], node.range[1]) : null;
        spelling[JSON.stringify(['spelling', role, path])] = isScalar(node)
          ? { tag: node.tag ?? null, spelling: authValue }
          : { tag: node.tag ?? null, flow: node.flow === true };
      }
      if (isMap(node)) {for (const pair of node.items) {
        need(isScalar(pair.key) && typeof pair.key.value === 'string', 'annotation key');
        const next = [...path, pair.key.value];
        visit(pair.key, next, 'key'); visit(pair.value, next, 'value');
      }}
      if (isSeq(node)) {
        node.items.forEach((item, index) => {visit(item, [...path, index], 'value');});
      }
    }
    comment(document, [], 'document'); visit(document.contents, [], 'value');
    return { comments, spelling };
  }

  const sourceText = Buffer.from(sourceBytes).toString('utf8');
  const source = parseDocument(sourceText, { schema: 'core', version: '1.2', keepSourceTokens: true });
  need(source.errors.length === 0, 'annotation YAML');
  preflight(source, mappedWidths());
  const actualText = Buffer.from(actualBytes).toString('utf8');
  const actual = parseDocument(actualText, { schema: 'core', version: '1.2', keepSourceTokens: true });
  need(actual.errors.length === 0, 'annotation YAML');
  preflight(actual, new Map());
  // Neither annotation map nor serialized path exists before both preflights pass.
  return { source: materialize(source, sourceText, rename),
    actual: materialize(actual, actualText, new Map()) };
}
