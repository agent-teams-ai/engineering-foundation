import type {
  LanguageOptions,
  MessagePlaceholderData,
  RuleContext as PublicRuleContext,
  RuleDefinition,
  RuleFixer as PublicFixFunction,
  RulesMeta,
  RuleTextEdit,
  RuleTextEditor,
  SuggestedEdit,
  TextSourceCode,
} from "@eslint/core";
import type { Scope, ScopeManager, ScopeVariable } from "./scope-runtime.js";
import type * as TSESTree from "./ast.js";

type SyntaxElement = TSESTree.Node | TSESTree.Token | TSESTree.Comment;
type TokenOptions = number | ((token: TSESTree.Token) => boolean) | {
  filter?: (token: TSESTree.Token) => boolean;
  skip?: number;
  count?: number;
  includeComments?: false;
};

/** ESLint's public source contract, specialized to the qualified parser. */
export interface SourceCode extends TextSourceCode<{
  LangOptions: LanguageOptions;
  RootNode: TSESTree.Program;
  SyntaxElementWithLoc: SyntaxElement;
  ConfigNode: TSESTree.Comment;
}> {
  readonly lines: string[];
  readonly scopeManager: ScopeManager | null;
  getAllComments(): TSESTree.Comment[];
  getCommentsBefore(node: TSESTree.Node): TSESTree.Comment[];
  getText(node?: SyntaxElement, beforeCount?: number, afterCount?: number): string;
  getLocFromIndex(index: number): TSESTree.Position;
  getIndexFromLoc(location: TSESTree.Position): number;
  getScope(node: TSESTree.Node): Scope;
  getDeclaredVariables(node: TSESTree.Node): ScopeVariable[];
  getAncestors(node: TSESTree.Node): TSESTree.Node[];
  markVariableAsUsed(name: string, node: TSESTree.Node): boolean;
  getFirstToken(node: SyntaxElement, options?: TokenOptions): TSESTree.Token | null;
  getLastToken(node: SyntaxElement, options?: TokenOptions): TSESTree.Token | null;
  getTokenBefore(node: SyntaxElement, options?: TokenOptions): TSESTree.Token | null;
  getTokenAfter(node: SyntaxElement, options?: TokenOptions): TSESTree.Token | null;
  getTokensAfter(node: SyntaxElement, options?: TokenOptions): TSESTree.Token[];
}

type NodeFor<Type extends TSESTree.Node["type"]> = Extract<TSESTree.Node, { type: Type }>;
type NamedListeners = {
  [Type in TSESTree.Node["type"]]?: (node: NodeFor<Type>) => void;
} & {
  [Type in TSESTree.Node["type"] as `${Type}:exit`]?: (node: NodeFor<Type>) => void;
};

/** These selector relationships are exercised by independent runtime fixtures. */
type SelectorListeners = {
  ":not(ArrowFunctionExpression) > TSTypeParameterDeclaration > TSTypeParameter[constraint]"?: (node: TSESTree.TSTypeParameter & { constraint: TSESTree.TypeNode }) => void;
  "ArrowFunctionExpression > TSTypeParameterDeclaration > TSTypeParameter[constraint]"?: (node: TSESTree.TSTypeParameter & { constraint: TSESTree.TypeNode }) => void;
  "TSNonNullExpression > ChainExpression"?: (node: TSESTree.ChainExpression) => void;
  "ChainExpression > TSNonNullExpression"?: (node: TSESTree.TSNonNullExpression) => void;
  "CallExpression[optional = true] > TSNonNullExpression.callee"?: (node: TSESTree.TSNonNullExpression) => void;
  "MemberExpression[optional = true] > TSNonNullExpression.object"?: (node: TSESTree.TSNonNullExpression) => void;
  "TSNonNullExpression > TSNonNullExpression"?: (node: TSESTree.TSNonNullExpression) => void;
  "CallExpression[callee.name=\"require\"]"?: (node: TSESTree.CallExpression) => void;
  "TSModuleDeclaration[global!=true][id.type!='Literal']"?: (node: TSESTree.TSModuleDeclaration) => void;
  "VariableDeclarator[init.type='ThisExpression'], AssignmentExpression[right.type='ThisExpression']"?: (node: TSESTree.VariableDeclarator | TSESTree.AssignmentExpression) => void;
  "ClassBody > MethodDefinition[key.name='new']"?: (node: TSESTree.MethodDefinition) => void;
  "TSInterfaceBody > TSConstructSignatureDeclaration"?: (node: TSESTree.TSConstructSignatureDeclaration) => void;
  "TSMethodSignature[key.name='constructor']"?: (node: TSESTree.TSMethodSignature) => void;
}

export type RuleListener = NamedListeners & SelectorListeners;
export type RuleContext<MessageIds extends string, Options extends readonly unknown[]> = PublicRuleContext<{
  LangOptions: LanguageOptions;
  Code: SourceCode;
  RuleOptions: [...Options];
  Node: SyntaxElement;
  MessageIds: MessageIds;
}>;

export interface RuleDocs {
  extendsBaseRule?: boolean | string;
  requiresTypeChecking?: boolean;
}

export type SyntaxRule<Options extends readonly unknown[], MessageIds extends string> = RuleDefinition<{
  LangOptions: LanguageOptions;
  Code: SourceCode;
  RuleOptions: [...Options];
  Visitor: RuleListener;
  Node: SyntaxElement;
  MessageIds: MessageIds;
  ExtRuleDocs: RuleDocs;
}> & {
  name: string;
  meta: RulesMeta<MessageIds, [...Options], RuleDocs>;
  defaultOptions: Readonly<Options>;
};

export type RuleFix = RuleTextEdit;
export type RuleFixer = RuleTextEditor;
export type ReportFixFunction = PublicFixFunction;
export type ReportSuggestionArray<MessageIds extends string> = SuggestedEdit<MessageIds>[];
export type ReportDescriptorMessageData = MessagePlaceholderData;
