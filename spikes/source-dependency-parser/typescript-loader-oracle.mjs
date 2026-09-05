/** Direct-loader oracle for the shared syntax corpus; TS owns lexical lookup. */
export function typescriptLoaderOracle(ts, sourceFile) {
  const host = {
    getSourceFile: (name) => name === sourceFile.fileName ? sourceFile : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile() {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => name === sourceFile.fileName,
    readFile() {},
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const checker = ts.createProgram([sourceFile.fileName], { noLib: true }, host).getTypeChecker();
  return (expression) => {
    const identifier = ts.isIdentifier(expression) && expression.text === "require"
      ? expression : ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "require" && ts.isIdentifier(expression.expression) &&
        expression.expression.text === "module" ? expression.expression : undefined;
    return identifier !== undefined && checker.getSymbolAtLocation(identifier) === undefined
      ? { kind: "loader" } : undefined;
  };
}
