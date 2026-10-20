import type { Checker } from "typescript/unstable/sync";
import type { Expression } from "typescript/unstable/ast";
import * as ts from "typescript/unstable/ast";

/** Direct-loader oracle for the shared syntax corpus; TS owns lexical lookup. */
export function typescriptLoaderOracle(checker: Checker): (expression: Expression) => { kind: "loader" } | undefined {
  return (expression) => {
    const identifier = ts.isIdentifier(expression) && expression.text === "require"
      ? expression : ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "require" && ts.isIdentifier(expression.expression) &&
        expression.expression.text === "module" ? expression.expression : undefined;
    return identifier !== undefined && checker.getSymbolAtLocation(identifier) === undefined
      ? { kind: "loader" } : undefined;
  };
}
