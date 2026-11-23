// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
import type {
  Definition,
  ImportBindingDefinition,
} from "../scope-runtime.js";

import { DefinitionType } from "../scope-runtime.js";
import { AST_NODE_TYPES } from "../ast.js";

/**
 * Determine whether a variable definition is a type import. e.g.:
 *
 * ```ts
 * import type { Foo } from 'foo';
 * import { type Bar } from 'bar';
 * ```
 *
 * @param definition - The variable definition to check.
 */
export function isTypeImport(
  definition?: Definition,
): definition is ImportBindingDefinition {
  return (
    definition?.type === DefinitionType.ImportBinding &&
    (definition.parent.importKind === 'type' ||
      (definition.node.type === AST_NODE_TYPES.ImportSpecifier &&
        definition.node.importKind === 'type'))
  );
}
