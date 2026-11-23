// Retained parser ESTree contract from @typescript-eslint/types 8.73.0 (MIT).
// Exact provenance and native nullability adaptations: eslint-syntax-provenance.json.
import type {
  AST_NODE_TYPES,
  AST_TOKEN_TYPES,
  ArrayExpression,
  AssignmentOperatorToText,
  AssignmentPattern,
  BaseNode,
  BaseToken,
  BlockStatement,
  BreakStatement,
  CallExpression,
  ClassBody,
  ClassDeclarationWithName,
  ClassPropertyDefinitionNonComputedNameBase,
  ClassPropertyNameNonComputed,
  ContinueStatement,
  DebuggerStatement,
  Decorator,
  DestructuringPattern,
  DoWhileStatement,
  EmptyStatement,
  ExportAllDeclaration,
  ExportDefaultDeclaration,
  ExportNamedDeclaration,
  Expression,
  ExpressionStatement,
  ForInStatement,
  ForOfStatement,
  ForStatement,
  FunctionDeclarationWithName,
  Identifier,
  IfStatement,
  ImportDeclaration,
  LabeledStatement,
  LiteralBase,
  NewExpression,
  NumberLiteral,
  ObjectExpression,
  ObjectPattern,
  Position,
  PropertyBase,
  PropertyDefinition,
  PropertyDefinitionBase,
  StringLiteral,
  SwitchStatement,
  TSDeclareFunction,
  TSEnumDeclaration,
  TSExportAssignment,
  TSImportEqualsDeclaration,
  TSInterfaceDeclaration,
  TSModuleDeclaration,
  TSNamespaceExportDeclaration,
  TSTypeAliasDeclaration,
  TSTypeAnnotation,
  ThrowStatement,
  TryStatement,
  ValueOf,
  VariableDeclaration,
  WhileStatement,
  WithStatement,
} from "../ast.js";

export interface PropertyDefinitionNonComputedName extends ClassPropertyDefinitionNonComputedNameBase {
    type: AST_NODE_TYPES.PropertyDefinition;
}
export interface PropertyDefinitionNonComputedName {
    parent: ClassBody;
}
export interface PropertyDefinitionNonComputedNameBase extends PropertyDefinitionBase {
    computed: false;
    key: PropertyNameNonComputed;
}
export type PropertyName = ClassPropertyNameNonComputed | PropertyNameComputed | PropertyNameNonComputed;
export type PropertyNameComputed = Expression;
export type PropertyNameNonComputed = Identifier | NumberLiteral | StringLiteral;
export interface PropertyNonComputedName extends PropertyBase {
    computed: false;
    key: PropertyNameNonComputed;
}
export interface PropertyNonComputedName {
    parent: ObjectExpression | ObjectPattern;
}
export interface PunctuatorToken extends BaseToken {
    type: AST_TOKEN_TYPES.Punctuator;
    value: ValueOf<PunctuatorTokenToText>;
}
export interface PunctuatorTokenToText extends AssignmentOperatorToText {
    AmpersandAmpersandToken: '&&';
    AmpersandToken: '&';
    AsteriskAsteriskToken: '**';
    AsteriskToken: '*';
    AtToken: '@';
    BacktickToken: '`';
    BarBarToken: '||';
    BarToken: '|';
    CaretToken: '^';
    CloseBraceToken: '}';
    CloseBracketToken: ']';
    CloseParenToken: ')';
    ColonToken: ':';
    CommaToken: ',';
    DotDotDotToken: '...';
    DotToken: '.';
    EqualsEqualsEqualsToken: '===';
    EqualsEqualsToken: '==';
    EqualsGreaterThanToken: '=>';
    ExclamationEqualsEqualsToken: '!==';
    ExclamationEqualsToken: '!=';
    ExclamationToken: '!';
    GreaterThanEqualsToken: '>=';
    GreaterThanGreaterThanGreaterThanToken: '>>>';
    GreaterThanGreaterThanToken: '>>';
    GreaterThanToken: '>';
    HashToken: '#';
    LessThanEqualsToken: '<=';
    LessThanLessThanToken: '<<';
    LessThanSlashToken: '</';
    LessThanToken: '<';
    MinusMinusToken: '--';
    MinusToken: '-';
    OpenBraceToken: '{';
    OpenBracketToken: '[';
    OpenParenToken: '(';
    PercentToken: '%';
    PlusPlusToken: '++';
    PlusToken: '+';
    QuestionDotToken: '?.';
    QuestionQuestionToken: '??';
    QuestionToken: '?';
    SemicolonToken: ';';
    SlashToken: '/';
    TildeToken: '~';
}
/**
 * An array of two numbers.
 * Both numbers are a 0-based index which is the position in the array of source code characters.
 * The first is the start position of the node, the second is the end position of the node.
 */
export type Range = [number, number];
export interface RegExpLiteral extends LiteralBase {
    regex: {
        flags: string;
        pattern: string;
    };
    value: RegExp | null;
}
export interface RegularExpressionToken extends BaseToken {
    type: AST_TOKEN_TYPES.RegularExpression;
    regex: {
        flags: string;
        pattern: string;
    };
}
export interface RestElement extends BaseNode {
    type: AST_NODE_TYPES.RestElement;
    argument: DestructuringPattern;
    decorators: Decorator[];
    optional: boolean;
    typeAnnotation: TSTypeAnnotation | undefined | null;
    value: AssignmentPattern | undefined | null;
}
export interface ReturnStatement extends BaseNode {
    type: AST_NODE_TYPES.ReturnStatement;
    argument: Expression | null;
}
export interface SequenceExpression extends BaseNode {
    type: AST_NODE_TYPES.SequenceExpression;
    expressions: Expression[];
}
export interface SourceLocation {
    /**
     * The position of the first character after the parsed source region
     */
    end: Position;
    /**
     * The position of the first character of the parsed source region
     */
    start: Position;
}
export interface SpreadElement extends BaseNode {
    type: AST_NODE_TYPES.SpreadElement;
    argument: Expression;
}
export interface SpreadElement {
    parent: ArrayExpression | CallExpression | NewExpression | ObjectExpression;
}
export type Statement = BlockStatement | BreakStatement | ClassDeclarationWithName | ContinueStatement | DebuggerStatement | DoWhileStatement | EmptyStatement | ExportAllDeclaration | ExportDefaultDeclaration | ExportNamedDeclaration | ExpressionStatement | ForInStatement | ForOfStatement | ForStatement | FunctionDeclarationWithName | IfStatement | ImportDeclaration | LabeledStatement | ReturnStatement | SwitchStatement | ThrowStatement | TryStatement | TSDeclareFunction | TSEnumDeclaration | TSExportAssignment | TSImportEqualsDeclaration | TSInterfaceDeclaration | TSModuleDeclaration | TSNamespaceExportDeclaration | TSTypeAliasDeclaration | VariableDeclaration | WhileStatement | WithStatement;
