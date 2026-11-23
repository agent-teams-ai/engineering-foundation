// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  BaseNode,
  EntityName,
  Expression,
  FunctionBase,
  Identifier,
  ImportKind,
  ObjectExpression,
  Parameter,
  StringLiteral,
  TSDeclareFunctionBase,
  TSQualifiedName,
  TSTypeAnnotation,
  TSTypeParameterDeclaration,
  TSTypeParameterInstantiation,
  TypeNode,
} from "../ast.js";

export interface TSDeclareFunctionWithDeclare extends TSDeclareFunctionBase {
    /**
     * TS1040: 'async' modifier cannot be used in an ambient context.
     */
    async: false;
    declare: true;
    /**
     * TS1221: Generators are not allowed in an ambient context.
     */
    generator: false;
}
export interface TSDeclareKeyword extends BaseNode {
    type: AST_NODE_TYPES.TSDeclareKeyword;
}
export interface TSEmptyBodyFunctionExpression extends FunctionBase {
    type: AST_NODE_TYPES.TSEmptyBodyFunctionExpression;
    body: null;
    id: null;
}
export interface TSEnumBody extends BaseNode {
    type: AST_NODE_TYPES.TSEnumBody;
    members: TSEnumMember[];
}
export interface TSEnumBody {
    parent: TSEnumDeclaration;
}
export interface TSEnumDeclaration extends BaseNode {
    type: AST_NODE_TYPES.TSEnumDeclaration;
    /**
     * The body of the enum.
     */
    body: TSEnumBody;
    /**
     * Whether this is a `const` enum.
     * @example
     * ```ts
     * const enum Foo {}
     * ```
     */
    const: boolean;
    /**
     * Whether this is a `declare`d enum.
     * @example
     * ```ts
     * enum Foo {}
     * ```
     */
    declare: boolean;
    /**
     * The enum name.
     */
    id: Identifier;
    /**
     * The enum members.
     * @deprecated Use {@link body} instead.
     */
    members: TSEnumMember[];
}
export interface TSEnumMember extends BaseNode {
    type: AST_NODE_TYPES.TSEnumMember;
    id: Identifier | StringLiteral;
    initializer: Expression | undefined | null;
    /**
     * @deprecated the enum member is always non-computed.
     */
    computed: boolean;
}
export interface TSEnumMember {
    parent: TSEnumBody;
}
export interface TSExportAssignment extends BaseNode {
    type: AST_NODE_TYPES.TSExportAssignment;
    expression: Expression;
}
export interface TSExportKeyword extends BaseNode {
    type: AST_NODE_TYPES.TSExportKeyword;
}
export interface TSExternalModuleReference extends BaseNode {
    type: AST_NODE_TYPES.TSExternalModuleReference;
    expression: StringLiteral;
}
export interface TSFunctionSignatureBase extends BaseNode {
    params: Parameter[];
    returnType: TSTypeAnnotation | undefined | null;
    typeParameters: TSTypeParameterDeclaration | undefined | null;
}
export interface TSFunctionType extends TSFunctionSignatureBase {
    type: AST_NODE_TYPES.TSFunctionType;
}
export interface TSHeritageBase extends BaseNode {
    expression: Expression;
    typeArguments: TSTypeParameterInstantiation | undefined | null;
}
export type TSImportEqualsDeclaration = TSImportEqualsNamespaceDeclaration | TSImportEqualsRequireDeclaration;
export interface TSImportEqualsDeclarationBase extends BaseNode {
    type: AST_NODE_TYPES.TSImportEqualsDeclaration;
    /**
     * The locally imported name.
     */
    id: Identifier;
    /**
     * The kind of the import. Always `'value'` unless `moduleReference` is a
     * `TSExternalModuleReference`.
     */
    importKind: ImportKind;
    /**
     * The value being aliased.
     * @example
     * ```ts
     * import F1 = A;
     * import F2 = A.B.C;
     * import F3 = require('mod');
     * ```
     */
    moduleReference: Identifier | TSExternalModuleReference | TSQualifiedName;
}
export interface TSImportEqualsNamespaceDeclaration extends TSImportEqualsDeclarationBase {
    /**
     * The kind of the import.
     */
    importKind: 'value';
    /**
     * The value being aliased.
     * ```
     * import F1 = A;
     * import F2 = A.B.C;
     * ```
     */
    moduleReference: Identifier | TSQualifiedName;
}
export interface TSImportEqualsRequireDeclaration extends TSImportEqualsDeclarationBase {
    /**
     * The kind of the import.
     */
    importKind: ImportKind;
    /**
     * The value being aliased.
     * ```
     * import F3 = require('mod');
     * ```
     */
    moduleReference: TSExternalModuleReference;
}
export interface TSImportType extends BaseNode {
    type: AST_NODE_TYPES.TSImportType;
    /** @deprecated Use {@link `source`} instead. */
    argument: TypeNode;
    options: ObjectExpression | null;
    qualifier: EntityName | null;
    source: StringLiteral;
    typeArguments: TSTypeParameterInstantiation | null;
}
