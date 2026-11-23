// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  AST_TOKEN_TYPES,
  AwaitExpression,
  BaseNode,
  BaseToken,
  BlockStatement,
  BooleanToken,
  CatchClause,
  Comment,
  Expression,
  IdentifierToken,
  JSXIdentifierToken,
  JSXTextToken,
  KeywordToken,
  LeftHandSideExpression,
  NullToken,
  NumericToken,
  PrivateIdentifierToken,
  PunctuatorToken,
  RegularExpressionToken,
  StringToken,
  TSAbstractKeyword,
  TSAnyKeyword,
  TSArrayType,
  TSAsyncKeyword,
  TSBigIntKeyword,
  TSBooleanKeyword,
  TSCallSignatureDeclaration,
  TSConditionalType,
  TSConstructSignatureDeclaration,
  TSConstructorType,
  TSDeclareKeyword,
  TSExportKeyword,
  TSFunctionType,
  TSImportType,
  TSIndexSignature,
  TSIndexedAccessType,
  TSInferType,
  TSIntersectionType,
  TSIntrinsicKeyword,
  TSLiteralType,
  TSMappedType,
  TSMethodSignature,
  TSNamedTupleMember,
  TSNeverKeyword,
  TSNullKeyword,
  TSNumberKeyword,
  TSObjectKeyword,
  TSOptionalType,
  TSPrivateKeyword,
  TSPropertySignature,
  TSProtectedKeyword,
  TSPublicKeyword,
  TSQualifiedName,
  TSReadonlyKeyword,
  TSRestType,
  TSStaticKeyword,
  TSStringKeyword,
  TSSymbolKeyword,
  TSTemplateLiteralType,
  TSThisType,
  TSTupleType,
  TSTypeLiteral,
  TSTypeOperator,
  TSTypeParameterInstantiation,
  TSTypePredicate,
  TSTypeQuery,
  TSTypeReference,
  UsingInForOfDeclaration,
  UsingInNormalContextDeclaration,
} from "../ast.js";

export type TSUnaryExpression =
  | AwaitExpression
  | LeftHandSideExpression
  | UnaryExpression
  | UpdateExpression;
export interface TSUndefinedKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSUndefinedKeyword;
}
export interface TSUnionType extends BaseNode {
  type: AST_NODE_TYPES.TSUnionType;
  types: TypeNode[];
}
export interface TSUnknownKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSUnknownKeyword;
}
export interface TSVoidKeyword extends BaseNode {
  type: AST_NODE_TYPES.TSVoidKeyword;
}
export interface TaggedTemplateExpression extends BaseNode {
  type: AST_NODE_TYPES.TaggedTemplateExpression;
  quasi: TemplateLiteral;
  tag: Expression;
  typeArguments: TSTypeParameterInstantiation | undefined | null;
}
export interface TemplateElement extends BaseNode {
  type: AST_NODE_TYPES.TemplateElement;
  tail: boolean;
  value: {
    cooked: string | null;
    raw: string;
  };
}
export interface TemplateElement {
  parent: TemplateLiteral | TSTemplateLiteralType;
}
export interface TemplateLiteral extends BaseNode {
  type: AST_NODE_TYPES.TemplateLiteral;
  expressions: Expression[];
  quasis: TemplateElement[];
}
export interface TemplateToken extends BaseToken {
  type: AST_TOKEN_TYPES.Template;
}
export interface ThisExpression extends BaseNode {
  type: AST_NODE_TYPES.ThisExpression;
}
export interface ThrowStatement extends BaseNode {
  type: AST_NODE_TYPES.ThrowStatement;
  argument: Expression;
}
export type Token =
  | BooleanToken
  | Comment
  | IdentifierToken
  | JSXIdentifierToken
  | JSXTextToken
  | KeywordToken
  | NullToken
  | NumericToken
  | PrivateIdentifierToken
  | PunctuatorToken
  | RegularExpressionToken
  | StringToken
  | TemplateToken;
export interface TryStatement extends BaseNode {
  type: AST_NODE_TYPES.TryStatement;
  block: BlockStatement;
  finalizer: BlockStatement | null;
  handler: CatchClause | null;
}
export type TypeElement =
  | TSCallSignatureDeclaration
  | TSConstructSignatureDeclaration
  | TSIndexSignature
  | TSMethodSignature
  | TSPropertySignature;
export type TypeNode =
  | TSAbstractKeyword
  | TSAnyKeyword
  | TSArrayType
  | TSAsyncKeyword
  | TSBigIntKeyword
  | TSBooleanKeyword
  | TSConditionalType
  | TSConstructorType
  | TSDeclareKeyword
  | TSExportKeyword
  | TSFunctionType
  | TSImportType
  | TSIndexedAccessType
  | TSInferType
  | TSIntersectionType
  | TSIntrinsicKeyword
  | TSLiteralType
  | TSMappedType
  | TSNamedTupleMember
  | TSNeverKeyword
  | TSNullKeyword
  | TSNumberKeyword
  | TSObjectKeyword
  | TSOptionalType
  | TSPrivateKeyword
  | TSProtectedKeyword
  | TSPublicKeyword
  | TSQualifiedName
  | TSReadonlyKeyword
  | TSRestType
  | TSStaticKeyword
  | TSStringKeyword
  | TSSymbolKeyword
  | TSTemplateLiteralType
  | TSThisType
  | TSTupleType
  | TSTypeLiteral
  | TSTypeOperator
  | TSTypePredicate
  | TSTypeQuery
  | TSTypeReference
  | TSUndefinedKeyword
  | TSUnionType
  | TSUnknownKeyword
  | TSVoidKeyword;
export type UnaryExpression =
  | UnaryExpressionBitwiseNot
  | UnaryExpressionDelete
  | UnaryExpressionMinus
  | UnaryExpressionNot
  | UnaryExpressionPlus
  | UnaryExpressionTypeof
  | UnaryExpressionVoid;
export interface UnaryExpressionBase extends BaseNode {
  type: AST_NODE_TYPES.UnaryExpression;
  argument: Expression;
  operator: string;
  /**
   * @deprecated The `prefix` property is always `true` and is only present for historical reasons.
   * See https://github.com/estree/estree/pull/118.
   */
  prefix: true;
}
export type UnaryExpressionBitwiseNot = UnaryExpressionSpecific<"~">;
export type UnaryExpressionDelete = UnaryExpressionSpecific<"delete">;
export type UnaryExpressionMinus = UnaryExpressionSpecific<"-">;
export type UnaryExpressionNot = UnaryExpressionSpecific<"!">;
export type UnaryExpressionPlus = UnaryExpressionSpecific<"+">;
export interface UnaryExpressionSpecific<T extends string> extends UnaryExpressionBase {
  operator: T;
}
export type UnaryExpressionTypeof = UnaryExpressionSpecific<"typeof">;
export type UnaryExpressionVoid = UnaryExpressionSpecific<"void">;
export interface UpdateExpression extends BaseNode {
  type: AST_NODE_TYPES.UpdateExpression;
  argument: Expression;
  operator: "++" | "--";
  prefix: boolean;
}
export type UsingDeclaration = UsingInForOfDeclaration | UsingInNormalContextDeclaration;
