import { remarkParse, unified, visit } from "./markdown-runtime.js";
import type { MarkdownSyntaxObservation, MarkdownSyntaxReader } from "../../../application/model/markdown-syntax.js";
const parser = unified().use(remarkParse).freeze();
export const readMarkdownSyntax: MarkdownSyntaxReader = (source, kind) => {
  const observations: MarkdownSyntaxObservation[] = [];
  visit(parser.parse(source), kind, (node) => {
    const value = node as MarkdownSyntaxObservation;
    observations.push({
      ...(value.depth === undefined ? {} : { depth: value.depth }),
      ...(value.lang === undefined ? {} : { lang: value.lang }),
      ...(value.meta === undefined ? {} : { meta: value.meta }),
      ...(value.position === undefined ? {} : { position: {
        start: { ...value.position.start }, end: { ...value.position.end }
      } })
    });
  });
  return observations;
};
