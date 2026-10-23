/** A lexical declaration, never evidence that a dispatcher executes its arguments. */
export interface StaticHostCommand {
  readonly entrypoint: string;
  readonly arguments: readonly string[];
}

export function isStaticRepositoryScriptPath(value: string): boolean {
  return (
    !value.startsWith("-") &&
    /^[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s)$/u.test(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function parseStaticHostCommand(source: string | undefined): StaticHostCommand | undefined {
  if (source === undefined || /[\r\n]/u.test(source)) {
    return undefined;
  }
  const tokens = source.replace(/^[ \t]+|[ \t]+$/gu, "").split(/[ \t]+/u);
  const entrypoint = tokens[1];
  if (
    tokens[0] !== "node" ||
    entrypoint === undefined ||
    !isStaticRepositoryScriptPath(entrypoint) ||
    !tokens.slice(2).every((token) => /^[A-Za-z0-9_./:-]+$/u.test(token))
  ) {
    return undefined;
  }
  return Object.freeze({ entrypoint, arguments: Object.freeze(tokens.slice(2)) });
}
