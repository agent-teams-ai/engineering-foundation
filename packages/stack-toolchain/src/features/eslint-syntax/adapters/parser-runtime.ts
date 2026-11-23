import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { Linter } from "eslint";
import { assertScopeResolution, isAdmittedScopeManager, isRecord } from "./scope-runtime.js";

interface NativeParser {
  parseForESLint(code: string, options?: unknown): unknown;
}

function isNativeParser(value: unknown): value is NativeParser {
  return isRecord(value) && typeof value["parseForESLint"] === "function";
}

function isVisitorKeys(value: unknown): value is Record<string, string[]> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (keys) => Array.isArray(keys) && keys.every((key: unknown) => typeof key === "string"),
    )
  );
}

const require = createRequire(import.meta.url);
const manifest: unknown = JSON.parse(
  readFileSync(require.resolve("eslint-parser-oxc/package.json"), "utf8"),
);
if (
  !isRecord(manifest) ||
  manifest["name"] !== "eslint-parser-oxc" ||
  manifest["version"] !== "0.1.1"
) {
  throw new Error(
    "stack-toolchain/eslint-syntax requires the qualified public eslint-parser-oxc 0.1.1 API.",
  );
}
const parserRequire = createRequire(require.resolve("eslint-parser-oxc"));
assertScopeResolution(parserRequire);
const nativeParser: unknown = require("eslint-parser-oxc");
if (!isNativeParser(nativeParser)) {
  throw new Error("The qualified native parser API is missing.");
}
const parseForESLint = nativeParser.parseForESLint.bind(nativeParser);

/** Preserves the native parser result; ESLint owns traversal, scopes and parents. */
export const parser: Linter.Parser = {
  meta: { name: "eslint-parser-oxc", version: "0.1.1" },
  parseForESLint(code: string, options?: unknown) {
    const result = parseForESLint(code, options);
    if (
      !isRecord(result) ||
      !isRecord(result["ast"]) ||
      result["ast"]["type"] !== "Program" ||
      !isRecord(result["scopeManager"]) ||
      !isVisitorKeys(result["visitorKeys"]) ||
      !isRecord(result["services"])
    ) {
      throw new Error("The qualified native parser returned an invalid ESLint result.");
    }
    if (!isAdmittedScopeManager(result["scopeManager"])) {
      throw new Error("The native parser returned a foreign scope-manager instance.");
    }
    return {
      ast: result["ast"],
      scopeManager: result["scopeManager"],
      visitorKeys: result["visitorKeys"],
      services: result["services"],
    };
  },
};
