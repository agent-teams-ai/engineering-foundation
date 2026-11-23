// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  AST_TOKEN_TYPES,
  BaseNode,
  BaseToken,
  BinaryExpression,
  BinaryOperatorToText,
  ClassBody,
  ClassDeclaration,
  ClassExpression,
  Expression,
  FunctionBase,
  LiteralBase,
  MethodDefinitionComputedNameBase,
  MethodDefinitionNonComputedNameBase,
  PropertyDefinitionComputedNameBase,
  PropertyDefinitionNonComputedNameBase,
  Statement,
  TSDeclareFunctionWithDeclare,
  TSFunctionSignatureBase,
  TSHeritageBase,
  TSInterfaceBody,
  TSTypeLiteral,
  TypeNode,
  ValueOf,
} from "../ast.js";

export interface StaticBlock extends BaseNode {
    type: AST_NODE_TYPES.StaticBlock;
    body: Statement[];
}
export interface StaticBlock {
    parent: ClassBody;
}
export interface StringLiteral extends LiteralBase {
    value: string;
}
export interface StringToken extends BaseToken {
    type: AST_TOKEN_TYPES.String;
}
export interface Super extends BaseNode {
    type: AST_NODE_TYPES.Super;
}
export interface SwitchCase extends BaseNode {
    type: AST_NODE_TYPES.SwitchCase;
    consequent: Statement[];
    test: Expression | null;
}
export interface SwitchCase {
    parent: SwitchStatement;
}
export interface SwitchStatement extends BaseNode {
    type: AST_NODE_TYPES.SwitchStatement;
    cases: SwitchCase[];
    discriminant: Expression;
}
export interface SymmetricBinaryExpression extends BaseNode {
    type: AST_NODE_TYPES.BinaryExpression;
    left: Expression;
    operator: ValueOf<BinaryOperatorToText>;
    right: Expression;
}
export type TSAbstractAccessorProperty = TSAbstractAccessorPropertyComputedName | TSAbstractAccessorPropertyNonComputedName;
export interface TSAbstractAccessorPropertyComputedName extends PropertyDefinitionComputedNameBase {
    type: AST_NODE_TYPES.TSAbstractAccessorProperty;
    value: null;
}
export interface TSAbstractAccessorPropertyComputedName {
    parent: ClassBody;
}
export interface TSAbstractAccessorPropertyNonComputedName extends PropertyDefinitionNonComputedNameBase {
    type: AST_NODE_TYPES.TSAbstractAccessorProperty;
    value: null;
}
export interface TSAbstractAccessorPropertyNonComputedName {
    parent: ClassBody;
}
export interface TSAbstractKeyword extends BaseNode {
    type: AST_NODE_TYPES.TSAbstractKeyword;
}
export type TSAbstractMethodDefinition = TSAbstractMethodDefinitionComputedName | TSAbstractMethodDefinitionNonComputedName;
export interface TSAbstractMethodDefinitionComputedName extends MethodDefinitionComputedNameBase {
    type: AST_NODE_TYPES.TSAbstractMethodDefinition;
}
export interface TSAbstractMethodDefinitionComputedName {
    parent: ClassBody;
}
export interface TSAbstractMethodDefinitionNonComputedName extends MethodDefinitionNonComputedNameBase {
    type: AST_NODE_TYPES.TSAbstractMethodDefinition;
}
export interface TSAbstractMethodDefinitionNonComputedName {
    parent: ClassBody;
}
export type TSAbstractPropertyDefinition = TSAbstractPropertyDefinitionComputedName | TSAbstractPropertyDefinitionNonComputedName;
export interface TSAbstractPropertyDefinitionComputedName extends PropertyDefinitionComputedNameBase {
    type: AST_NODE_TYPES.TSAbstractPropertyDefinition;
    value: null;
}
export interface TSAbstractPropertyDefinitionComputedName {
    parent: ClassBody;
}
export interface TSAbstractPropertyDefinitionNonComputedName extends PropertyDefinitionNonComputedNameBase {
    type: AST_NODE_TYPES.TSAbstractPropertyDefinition;
    value: null;
}
export interface TSAbstractPropertyDefinitionNonComputedName {
    parent: ClassBody;
}
export interface TSAnyKeyword extends BaseNode {
    type: AST_NODE_TYPES.TSAnyKeyword;
}
export interface TSArrayType extends BaseNode {
    type: AST_NODE_TYPES.TSArrayType;
    elementType: TypeNode;
}
export interface TSAsExpression extends BaseNode {
    type: AST_NODE_TYPES.TSAsExpression;
    expression: Expression;
    typeAnnotation: TypeNode;
}
export interface TSAsyncKeyword extends BaseNode {
    type: AST_NODE_TYPES.TSAsyncKeyword;
}
export interface TSBigIntKeyword extends BaseNode {
    type: AST_NODE_TYPES.TSBigIntKeyword;
}
export interface TSBooleanKeyword extends BaseNode {
    type: AST_NODE_TYPES.TSBooleanKeyword;
}
export interface TSCallSignatureDeclaration extends TSFunctionSignatureBase {
    type: AST_NODE_TYPES.TSCallSignatureDeclaration;
}
export interface TSCallSignatureDeclaration {
    parent: TSInterfaceBody | TSTypeLiteral;
}
export interface TSClassImplements extends TSHeritageBase {
    type: AST_NODE_TYPES.TSClassImplements;
}
export interface TSClassImplements {
    parent: ClassDeclaration | ClassExpression;
}
export interface TSConditionalType extends BaseNode {
    type: AST_NODE_TYPES.TSConditionalType;
    checkType: TypeNode;
    extendsType: TypeNode;
    falseType: TypeNode;
    trueType: TypeNode;
}
export interface TSConstructSignatureDeclaration extends TSFunctionSignatureBase {
    type: AST_NODE_TYPES.TSConstructSignatureDeclaration;
}
export interface TSConstructSignatureDeclaration {
    parent: TSInterfaceBody | TSTypeLiteral;
}
export interface TSConstructorType extends TSFunctionSignatureBase {
    type: AST_NODE_TYPES.TSConstructorType;
    abstract: boolean;
}
export type TSDeclareFunction = TSDeclareFunctionNoDeclare | TSDeclareFunctionWithDeclare;
export interface TSDeclareFunctionBase extends FunctionBase {
    type: AST_NODE_TYPES.TSDeclareFunction;
    /**
     * TS1183: An implementation cannot be declared in ambient contexts.
     */
    body: undefined;
    /**
     * Whether the declaration has `declare` modifier.
     */
    declare: boolean;
    expression: false;
}
/**
 * Function declaration without the `declare` keyword:
 * ```
 * function foo(): void;
 * ```
 * This can either be an overload signature or a declaration in an ambient context
 * (e.g. `module`)
 */
export interface TSDeclareFunctionNoDeclare extends TSDeclareFunctionBase {
    declare: false;
    /**
     * - TS1221: Generators are not allowed in an ambient context.
     * - TS1222: An overload signature cannot be declared as a generator.
     */
    generator: false;
}
/**
 * Function declaration with the `declare` keyword:
 * ```
 * function foo(): void;
 * ```
 */
