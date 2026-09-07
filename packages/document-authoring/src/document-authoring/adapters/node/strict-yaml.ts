import { createDocumentInputFailure } from "../../application/policies/document-input-failure.js";
import { isAlias, isMap, isNode, isPair, parseDocument, visit } from "yaml";


function invalid(code: "YAML_INVALID" | "YAML_FEATURE_PROHIBITED", message: string, phase: string): never {
  throw createDocumentInputFailure(code, message, phase);
}

export function parseStrictYamlSource(source: string, phase: string): unknown {
  const document = parseDocument(source, {
    customTags: [], merge: false, schema: "core", uniqueKeys: true
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const problem = [...document.errors, ...document.warnings]
      .slice(0, 8).map((error) => error.message).join("; ").slice(0, 1000);
    invalid("YAML_INVALID", problem || "YAML input is invalid.", phase);
  }
  let forbidden: string | undefined;
  visit(document, (_key, node) => {
    if (isAlias(node)) {
      forbidden = "YAML aliases are prohibited.";
    } else if (isNode(node) && (node.anchor !== undefined || node.tag !== undefined)) {
      forbidden = "YAML anchors and explicit tags are prohibited.";
    } else if (isPair(node) && isNode(node.key) && "value" in node.key && node.key.value === "<<") {
      forbidden = "YAML merge keys are prohibited.";
    } else if (isMap(node) && node.items.length > 10_000) {
      forbidden = "YAML mapping exceeds the supported size limit.";
    }
    return forbidden === undefined ? undefined : visit.BREAK;
  });
  if (forbidden !== undefined) {
    invalid("YAML_FEATURE_PROHIBITED", forbidden, phase);
  }
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}
