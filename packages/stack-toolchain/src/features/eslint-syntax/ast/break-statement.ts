// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  AccessorProperty,
  BaseNode,
  BindingName,
  BlockComment,
  BlockStatement,
  Decorator,
  ExportDefaultDeclaration,
  Expression,
  Identifier,
  LeftHandSideExpression,
  LetOrConstOrVarDeclarationBase,
  LineComment,
  MemberExpression,
  MethodDefinition,
  MethodDefinitionBase,
  PrivateIdentifier,
  PropertyDefinition,
  PropertyDefinitionBase,
  PropertyNameNonComputed,
  SpreadElement,
  StaticBlock,
  TSAbstractAccessorProperty,
  TSAbstractMethodDefinition,
  TSAbstractPropertyDefinition,
  TSClassImplements,
  TSIndexSignature,
  TSNonNullExpression,
  TSTypeParameterDeclaration,
  TSTypeParameterInstantiation,
  TryStatement,
  VariableDeclaratorMaybeInit,
} from "../ast.js";

export interface BreakStatement extends BaseNode {
    type: AST_NODE_TYPES.BreakStatement;
    label: Identifier | null;
}
export interface CallExpression extends BaseNode {
    type: AST_NODE_TYPES.CallExpression;
    arguments: CallExpressionArgument[];
    callee: Expression;
    optional: boolean;
    typeArguments: TSTypeParameterInstantiation | undefined | null;
}
export type CallExpressionArgument = Expression | SpreadElement;
export interface CatchClause extends BaseNode {
    type: AST_NODE_TYPES.CatchClause;
    body: BlockStatement;
    param: BindingName | null;
}
export interface CatchClause {
    parent: TryStatement;
}
export type ChainElement = CallExpression | MemberExpression | TSNonNullExpression;
export interface ChainExpression extends BaseNode {
    type: AST_NODE_TYPES.ChainExpression;
    expression: ChainElement;
}
export interface ClassBase extends BaseNode {
    /**
     * Whether the class is an abstract class.
     * @example
     * ```ts
     * abstract class Foo {}
     * ```
     */
    abstract: boolean;
    /**
     * The class body.
     */
    body: ClassBody;
    /**
     * Whether the class has been `declare`d:
     * @example
     * ```ts
     * class Foo {}
     * ```
     */
    declare: boolean;
    /**
     * The decorators declared for the class.
     * @example
     * ```ts
     * @deco
     * class Foo {}
     * ```
     */
    decorators: Decorator[];
    /**
     * The class's name.
     * - For a `ClassExpression` this may be `null` if the name is omitted.
     * - For a `ClassDeclaration` this may be `null` if and only if the parent is
     *   an `ExportDefaultDeclaration`.
     */
    id: Identifier | null;
    /**
     * The implemented interfaces for the class.
     */
    implements: TSClassImplements[];
    /**
     * The super class this class extends.
     */
    superClass: LeftHandSideExpression | null;
    /**
     * The generic type parameters passed to the superClass.
     */
    superTypeArguments: TSTypeParameterInstantiation | undefined | null;
    /**
     * The generic type parameters declared for the class.
     */
    typeParameters: TSTypeParameterDeclaration | undefined | null;
}
export interface ClassBody extends BaseNode {
    type: AST_NODE_TYPES.ClassBody;
    body: ClassElement[];
}
export interface ClassBody {
    parent: ClassDeclaration | ClassExpression;
}
export type ClassDeclaration = ClassDeclarationWithName | ClassDeclarationWithOptionalName;
export interface ClassDeclarationBase extends ClassBase {
    type: AST_NODE_TYPES.ClassDeclaration;
}
/**
 * A normal class declaration:
 * ```
 * class A {}
 * ```
 */
export interface ClassDeclarationWithName extends ClassDeclarationBase {
    id: Identifier;
}
/**
 * Default-exported class declarations have optional names:
 * ```
 * export default class {}
 * ```
 */
export interface ClassDeclarationWithOptionalName extends ClassDeclarationBase {
    id: Identifier | null;
}
export type ClassElement = AccessorProperty | MethodDefinition | PropertyDefinition | StaticBlock | TSAbstractAccessorProperty | TSAbstractMethodDefinition | TSAbstractPropertyDefinition | TSIndexSignature;
export interface ClassExpression extends ClassBase {
    type: AST_NODE_TYPES.ClassExpression;
    abstract: false;
    declare: false;
}
export interface ClassMethodDefinitionNonComputedNameBase extends MethodDefinitionBase {
    computed: false;
    key: ClassPropertyNameNonComputed;
}
export interface ClassPropertyDefinitionNonComputedNameBase extends PropertyDefinitionBase {
    computed: false;
    key: ClassPropertyNameNonComputed;
}
export type ClassPropertyNameNonComputed = PrivateIdentifier | PropertyNameNonComputed;
export type Comment = BlockComment | LineComment;
export interface ConditionalExpression extends BaseNode {
    type: AST_NODE_TYPES.ConditionalExpression;
    alternate: Expression;
    consequent: Expression;
    test: Expression;
}
export interface ConstDeclaration extends LetOrConstOrVarDeclarationBase {
    /**
     * In a `const` declaration, the declarators may have initializers, but
     * not definite assignment assertions. Each declarator cannot have both an
     * initializer and a type annotation.
     *
     * Even if the declaration has no `declare`, it may still be ambient and have
     * no initializer.
     */
    declarations: VariableDeclaratorMaybeInit[];
    kind: 'const';
}
export interface ContinueStatement extends BaseNode {
    type: AST_NODE_TYPES.ContinueStatement;
    label: Identifier | null;
}
export interface DebuggerStatement extends BaseNode {
    type: AST_NODE_TYPES.DebuggerStatement;
}
/**
 * @deprecated
 * Note that this is neither up to date nor fully correct.
 */
