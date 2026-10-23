export interface SymbolFixtureCase {
  name: string;
  safe: boolean;
  internal?: string[];
  factory?: string;
  code: string;
  extra?: Record<string, string>;
  [key: string]: unknown;
}
export function appendLexicalStarCases(
  feature: string,
  factorySource: string,
  specs: SymbolFixtureCase[],
  precisionStarCases: (feature: string, factorySource: string) => SymbolFixtureCase[],
): void {
  const adapter = feature + "/adapters/index.ts";
  const relay = feature + "/composition/lexical-relay.ts",
    leaf = feature + "/composition/lexical-leaf.ts";
  specs.push(...precisionStarCases(feature, factorySource));
  for (const kind of ["namespace", "const-enum", "runtime-namespace", "runtime-enum"]) {
    for (const route of ["local", "import", "reexport"]) {
      for (const safe of [false, true]) {
        const emitted = kind.startsWith("runtime"),
          declaration = kind.includes("namespace")
            ? "namespace expose {" +
              (emitted ? "export const data=1;" : "export interface Data {value:string}") +
              "}"
            : (emitted ? "" : "const ") + "enum expose {value=1}";
        const symbol = declaration + "export {expose};";
        const edge =
          route === "local"
            ? symbol
            : route === "import"
              ? 'import {expose as Alias} from "./lexical-leaf.js"; export {Alias as expose};'
              : 'export {expose} from "./lexical-leaf.js";';
        specs.push({
          name: `lexical erasure star ${kind} ${route} ${safe}`,
          safe: safe || emitted,
          internal: [relay, leaf],
          factory: factorySource.replace(
            "export function createApi",
            "export default function createApi",
          ),
          code:
            'import * as ns from "./lexical-relay.js"; import createApi from "../application/factory.js"; import {mutate} from "../adapters/index.js";' +
            (safe ? "" : "mutate(ns);") +
            "export const {execute}=createApi();",
          extra: {
            [relay]: edge + 'export * from "../application/factory.js";',
            [leaf]: symbol,
            [adapter]:
              'export function read(){return "adapter";} export function mutate(ns:any){if(typeof ns.expose==="function"){ns.expose().execute=read;}}',
          },
        });
      }
    }
  }
  for (const [name, declaration, safe = true] of [
    ["ambient member variable", "namespace expose {export declare const data:number;}"],
    ["ambient member function", "namespace expose {export declare function data():void;}"],
    ["nested-const-enum", "namespace expose {export const enum Data {value=1}}", false],
    [
      "nested-erased-namespace",
      "namespace expose {export namespace Data {export interface Value {value:string}}}",
      false,
    ],
    [
      "reopened-first",
      "namespace expose {export const data=1;} namespace expose {export interface Data {value:string}}",
    ],
    [
      "reopened-last",
      "namespace expose {export interface Data {value:string}} namespace expose {export const data=1;}",
    ],
    [
      "exported-value-alias",
      "namespace Source {export function local(){}} namespace expose {export import data=Source.local;}",
    ],
    [
      "exported-erased-alias",
      "namespace Source {export interface Local {value:string}} namespace expose {export import data=Source.Local;}",
    ],
  ] as const) {
    specs.push({
      name: `lexical erasure star ${name}`,
      safe,
      internal: [relay],
      factory: factorySource.replace(
        "export function createApi",
        "export default function createApi",
      ),
      code: 'import * as ns from "./lexical-relay.js"; import createApi from "../application/factory.js"; import {mutate} from "../adapters/index.js"; mutate(ns); export const {execute}=createApi();',
      extra: {
        [relay]: declaration + 'export {expose}; export * from "../application/factory.js";',
        [adapter]:
          'export function read(){return "adapter";} export function mutate(ns:any){if(typeof ns.expose==="function"){ns.expose().execute=read;}}',
      },
    });
  }
}
