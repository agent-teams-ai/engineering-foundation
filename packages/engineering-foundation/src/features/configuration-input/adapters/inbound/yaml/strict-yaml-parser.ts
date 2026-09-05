import { isAlias, isMap, isNode, isPair, parseDocument, visit } from "yaml";

import { CapabilityInputError } from "../../../../validation-reporting/api.js";

function inputError(code: string, message: string, phase: string): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false });
}

export function parseStrictYamlSource(source: string, phase: string): unknown {
  const document = parseDocument(source, {
    customTags: [],
    merge: false,
    schema: "core",
    uniqueKeys: true
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const problem = [...document.errors, ...document.warnings]
      .slice(0, 8)
      .map((error) => error.message)
      .join("; ")
      .slice(0, 1000);
    inputError("YAML_INVALID", problem || "YAML input is invalid.", phase);
  }

  let forbidden: string | undefined;
  visit(document, (_key, node) => {
    if (isAlias(node)) {
      forbidden = "YAML aliases are prohibited.";
      return visit.BREAK;
    }
    if (isNode(node) && (node.anchor !== undefined || node.tag !== undefined)) {
      forbidden = "YAML anchors and explicit tags are prohibited.";
      return visit.BREAK;
    }
    if (
      isPair(node) &&
      isNode(node.key) &&
      "value" in node.key &&
      node.key.value === "<<"
    ) {
      forbidden = "YAML merge keys are prohibited.";
      return visit.BREAK;
    }
    if (isMap(node) && node.items.length > 10_000) {
      forbidden = "YAML mapping exceeds the supported size limit.";
      return visit.BREAK;
    }
    return;
  });
  if (forbidden !== undefined) {
    inputError("YAML_FEATURE_PROHIBITED", forbidden, phase);
  }
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

