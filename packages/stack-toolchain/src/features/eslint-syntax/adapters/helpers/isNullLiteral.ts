import { isNullish } from "../source-helpers.js";
// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type * as TSESTree from "../ast.js";

import { AST_NODE_TYPES } from "../ast.js";

export function isNullLiteral(i: TSESTree.Node): i is TSESTree.NullLiteral {
  return i.type === AST_NODE_TYPES.Literal && isNullish(i.value);
}
