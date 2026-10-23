export const factoryCaseData0 = [
  [
    "exact rest forwarding",
    "export function execute(first: string, ...rest: readonly string[]) { return api.execute(first, ...rest); }",
  ],
  [
    "exact rest awaited forwarding",
    "export async function execute(first: string, ...rest: readonly string[]) { return await api.execute(first, ...rest); }",
  ],
  [
    "explicit synchronous void forwarding",
    "export function execute(value: string): void { api.execute(value); }",
  ],
  ["explicit zero-argument void forwarding", "export function execute(): void { api.execute(); }"],
] as const;
export const factoryCaseData1 = [
  [
    "rest passed as one argument",
    "export function execute(...args: string[]) { return api.execute(args); }",
  ],
  [
    "rest replaced by another spread",
    "export function execute(...args: string[]) { return api.execute(...[]); }",
  ],
  [
    "rest duplicated",
    "export function execute(...args: string[]) { return api.execute(...args, ...args); }",
  ],
  [
    "rest wrapper default argument",
    'export function execute(first = "changed", ...args: string[]) { return api.execute(first, ...args); }',
  ],
  [
    "void wrapper changes argument",
    'export function execute(value: string): void { api.execute(value + "!"); }',
  ],
  [
    "void wrapper calls different member",
    "export function execute(value: string): void { api.other(value); }",
  ],
  [
    "void wrapper adds side effect",
    "export function execute(value: string): void { api.execute(value); console.log(value); }",
  ],
  [
    "async void wrapper loses completion",
    "export async function execute(value: string): Promise<void> { api.execute(value); }",
  ],
  [
    "untyped wrapper discards return",
    "export function execute(value: string) { api.execute(value); }",
  ],
] as const;
export const factoryCaseData2 = [
  [
    "async factory",
    "export async function createApi() { function execute() { return 1; } return {execute}; }",
  ],
  [
    "generator factory",
    "export function* createApi() { function execute() { return 1; } return {execute}; }",
  ],
  [
    "prototype setter",
    "export function createApi() { function execute() { return 1; } return {__proto__: {hidden: execute}, execute}; }",
  ],
  [
    "captured object write",
    "export function createApi() { const api = {execute: () => 1, change: () => {api.execute = () => 2;}}; return api; }",
  ],
  [
    "captured alias write",
    "export function createApi() { const api = {execute: () => 1}; const alias = api; function change() { alias.execute = () => 2; } return api; }",
  ],
  [
    "captured typed alias write",
    "export function createApi() { const api = {execute: () => 1}; const alias = api as typeof api; function change() { alias.execute = () => 2; } return api; }",
  ],
  [
    "captured destructured target write",
    "export function createApi() { const api = {execute: () => 1}; function change() { ({execute: api.execute} = {execute: () => 2}); } return api; }",
  ],
  [
    "captured delete",
    "export function createApi() { const api = {execute: () => 1}; function change() { delete api.execute; } return api; }",
  ],
  [
    "captured reflective write",
    'export function createApi() { const api = {execute: () => 1}; function change() { Reflect.set(api, "execute", () => 2); } return api; }',
  ],
  [
    "block shadow followed by real captured write",
    "export function createApi() { const api = {execute: () => 1}; function change() { {const api = {execute: () => 3}; api.execute();} api.execute = () => 2; } return api; }",
  ],
  [
    "type-only factory declaration",
    "function createApi() { function execute() { return 1; } return {execute}; } export type {createApi};",
  ],
  [
    "cyclic local aliases",
    "export function createApi() { const first = second; const second = first; return {execute: first}; }",
  ],
] as const;
export const factoryCaseData3 = [
  [
    "unrelated captured state",
    "export function createApi() { const state = {count: 0}; function execute() { return ++state.count; } return {execute}; }",
  ],
  [
    "inner parameter shadow",
    "export function createApi() { const api = {execute: () => 1}; function change(api: {execute: () => number}) { api.execute = () => 2; } return api; }",
  ],
  [
    "inner block shadow",
    "export function createApi() { const api = {execute: () => 1}; function change() { {const api = {execute: () => 3}; api.execute = () => 2;} } return api; }",
  ],
  [
    "inner loop shadow",
    "export function createApi() { const api = {execute: () => 1}; function change() { for (const api of [{execute: () => 3}]) { api.execute = () => 2; } } return api; }",
  ],
] as const;
export const factoryCaseData4 = [
  [
    "missing returned member",
    "export function createApi() { function other() { return 1; } return {other}; }",
  ],
  [
    "computed returned key",
    'export function createApi() { function execute() { return 1; } return {["execute"]: execute}; }',
  ],
  [
    "spread returned object",
    "export function createApi() { function execute() { return 1; } return {...{execute}}; }",
  ],
  [
    "returned getter",
    "export function createApi() { return {get execute() { return () => 1; }}; }",
  ],
  [
    "duplicate returned key",
    "export function createApi() { function execute() { return 1; } return {execute, execute}; }",
  ],
  [
    "conditional return",
    "export function createApi() { function execute() { return 1; } if (Date.now()) { return {execute}; } return {}; }",
  ],
  [
    "reassigned local operation",
    "export function createApi() { let execute = () => 1; execute = () => 2; return {execute}; }",
  ],
  [
    "mutated object member",
    "export function createApi() { const api = {execute: () => 1}; api.execute = () => 2; return api; }",
  ],
  ["recursive result", "export function createApi() { return createApi(); }"],
] as const;
