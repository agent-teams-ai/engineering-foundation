// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  Accessibility,
  BaseNode,
  CallExpressionArgument,
  ClassBody,
  ClassDeclarationWithName,
  ClassDeclarationWithOptionalName,
  ClassMethodDefinitionNonComputedNameBase,
  Decorator,
  Expression,
  FunctionDeclarationWithName,
  FunctionDeclarationWithOptionalName,
  FunctionExpression,
  Identifier,
  PrivateIdentifier,
  PropertyName,
  PropertyNameComputed,
  PropertyNameNonComputed,
  TSDeclareFunction,
  TSEmptyBodyFunctionExpression,
  TSEnumDeclaration,
  TSImportEqualsDeclaration,
  TSInterfaceDeclaration,
  TSModuleDeclaration,
  TSTypeAliasDeclaration,
  TSTypeParameterInstantiation,
  VariableDeclaration,
} from "../ast.js";

export type MemberExpression = MemberExpressionComputedName | MemberExpressionNonComputedName;
export interface MemberExpressionBase extends BaseNode {
    computed: boolean;
    object: Expression;
    optional: boolean;
    property: Expression | Identifier | PrivateIdentifier;
}
export interface MemberExpressionComputedName extends MemberExpressionBase {
    type: AST_NODE_TYPES.MemberExpression;
    computed: true;
    property: Expression;
}
export interface MemberExpressionNonComputedName extends MemberExpressionBase {
    type: AST_NODE_TYPES.MemberExpression;
    computed: false;
    property: Identifier | PrivateIdentifier;
}
export interface MetaProperty extends BaseNode {
    type: AST_NODE_TYPES.MetaProperty;
    meta: Identifier;
    property: Identifier;
}
export type MethodDefinition = MethodDefinitionComputedName | MethodDefinitionNonComputedName;
/** this should not be directly used - instead use MethodDefinitionComputedNameBase or MethodDefinitionNonComputedNameBase */
export interface MethodDefinitionBase extends BaseNode {
    accessibility: Accessibility | undefined;
    computed: boolean;
    decorators: Decorator[];
    key: PropertyName;
    kind: 'constructor' | 'get' | 'method' | 'set';
    optional: boolean;
    override: boolean;
    static: boolean;
    value: FunctionExpression | TSEmptyBodyFunctionExpression;
}
export interface MethodDefinitionComputedName extends MethodDefinitionComputedNameBase {
    type: AST_NODE_TYPES.MethodDefinition;
}
export interface MethodDefinitionComputedName {
    parent: ClassBody;
}
export interface MethodDefinitionComputedNameBase extends MethodDefinitionBase {
    computed: true;
    key: PropertyNameComputed;
}
export interface MethodDefinitionNonComputedName extends ClassMethodDefinitionNonComputedNameBase {
    type: AST_NODE_TYPES.MethodDefinition;
}
export interface MethodDefinitionNonComputedName {
    parent: ClassBody;
}
export interface MethodDefinitionNonComputedNameBase extends MethodDefinitionBase {
    computed: false;
    key: PropertyNameNonComputed;
}
export type NamedExportDeclarations = ClassDeclarationWithName | ClassDeclarationWithOptionalName | FunctionDeclarationWithName | FunctionDeclarationWithOptionalName | TSDeclareFunction | TSEnumDeclaration | TSImportEqualsDeclaration | TSInterfaceDeclaration | TSModuleDeclaration | TSTypeAliasDeclaration | VariableDeclaration;
export interface NewExpression extends BaseNode {
    type: AST_NODE_TYPES.NewExpression;
    arguments: CallExpressionArgument[];
    callee: Expression;
    typeArguments: TSTypeParameterInstantiation | undefined | null;
}
