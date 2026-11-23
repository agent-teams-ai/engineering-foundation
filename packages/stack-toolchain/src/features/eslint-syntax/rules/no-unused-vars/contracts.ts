// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.

import type { Definition, ScopeVariable } from "../../scope-runtime.js";
import type * as TSESTree from "../../ast.js";

import { DefinitionType } from "../../scope-runtime.js";
import type * as TSESLint from "../../rule-contract.js";

import type { MakeRequired } from "../../helpers/index.js";

export type MessageIds =
  | "removeUnusedImportDeclaration"
  | "removeUnusedVar"
  | "unusedVar"
  | "usedIgnoredVar"
  | "usedOnlyAsType";

export type Options = [
  | "all"
  | "local"
  | {
      args?: "after-used" | "all" | "none";
      argsIgnorePattern?: string;
      caughtErrors?: "all" | "none";
      caughtErrorsIgnorePattern?: string;
      destructuredArrayIgnorePattern?: string;
      enableAutofixRemoval?: {
        imports?: boolean;
      };
      ignoreClassWithStaticInitBlock?: boolean;
      ignoreRestSiblings?: boolean;
      ignoreUsingDeclarations?: boolean;
      reportUsedIgnorePattern?: boolean;
      vars?: "all" | "local";
      varsIgnorePattern?: string;
    },
];

export interface TranslatedOptions {
  args: "after-used" | "all" | "none";
  argsIgnorePattern?: RegExp;
  caughtErrors: "all" | "none";
  caughtErrorsIgnorePattern?: RegExp;
  destructuredArrayIgnorePattern?: RegExp;
  enableAutofixRemoval: {
    imports: boolean;
  };
  ignoreClassWithStaticInitBlock: boolean;
  ignoreRestSiblings: boolean;
  ignoreUsingDeclarations: boolean;
  reportUsedIgnorePattern: boolean;
  vars: "all" | "local";
  varsIgnorePattern?: RegExp;
}

export enum VariableType {
  // New sub-types
  ArrayDestructure,

  // DefinitionType
  CatchClause,
  ClassName,
  FunctionName,
  ImportBinding,
  ImplicitGlobalVariable,
  Parameter,
  TSEnumMember,
  TSEnumName,
  TSModuleName,
  Type,
  Variable,
}

export type DefToVariableType =
  | {
      type: VariableType.ArrayDestructure;
      def: Definition;
    }
  | {
      type: VariableType.CatchClause;
      def: Definition & { type: DefinitionType.CatchClause };
    }
  | {
      type: VariableType.ClassName;
      def: Definition & { type: DefinitionType.ClassName };
    }
  | {
      type: VariableType.FunctionName;
      def: Definition & { type: DefinitionType.FunctionName };
    }
  | {
      type: VariableType.ImplicitGlobalVariable;
      def: Definition & { type: DefinitionType.ImplicitGlobalVariable };
    }
  | {
      type: VariableType.ImportBinding;
      def: Definition & { type: DefinitionType.ImportBinding };
    }
  | {
      type: VariableType.Parameter;
      def: Definition & { type: DefinitionType.Parameter };
    }
  | {
      type: VariableType.TSEnumMember;
      def: Definition & { type: DefinitionType.TSEnumMember };
    }
  | {
      type: VariableType.TSEnumName;
      def: Definition & { type: DefinitionType.TSEnumName };
    }
  | {
      type: VariableType.TSModuleName;
      def: Definition & { type: DefinitionType.TSModuleName };
    }
  | {
      type: VariableType.Type;
      def: Definition & { type: DefinitionType.Type };
    }
  | {
      type: VariableType.Variable;
      def: Definition & { type: DefinitionType.Variable };
    };

export type ModuleDeclarationWithBody = MakeRequired<TSESTree.TSModuleDeclaration, "body">;

export type DeclarationSelectorNode =
  | TSESTree.ClassDeclaration
  | TSESTree.FunctionDeclaration
  | TSESTree.TSDeclareFunction
  | TSESTree.TSEnumDeclaration
  | TSESTree.TSInterfaceDeclaration
  | TSESTree.TSModuleDeclaration
  | TSESTree.TSTypeAliasDeclaration
  | TSESTree.VariableDeclaration;

export interface RuleState {
  context: TSESLint.RuleContext<MessageIds, Options>;
  options: TranslatedOptions;
  reportedUnusedVariables: Set<ScopeVariable>;
  MODULE_DECL_CACHE: Map<ModuleDeclarationWithBody | TSESTree.Program, boolean>;
}
