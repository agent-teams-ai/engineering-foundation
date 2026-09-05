import test from "node:test";

const error = `export class DataError extends Error {
  readonly failure: string;
  constructor(failure: string) { super(\`Data failure: \${failure}.\`); this.name = "DataError"; this.failure = failure; }
}`;
const use = 'export function compare() { try { throw new DataError("invalid"); } catch { return 1; } }';
export function registerPrimitiveErrorCases(primitiveFixture, expectPass, rejects, qualifyPrimitive) {
  for (const [name, source] of [
    ["readonly failure data", error + use],
    ["message-only error", 'export class DataError extends Error { public constructor(message: string) { super(message); this.name = "DataError"; } }' + use]
  ]) {test(`primitive error accepts ${name}`, async (t) => {
    const f = await primitiveFixture(t), proof = await qualifyPrimitive(f, source, [1, 1]);
    await expectPass(f); t.diagnostic(JSON.stringify(proof));
  });}
  for (const [name, source] of [
    ["mutable payload", error.replace("readonly failure", "failure") + use],
    ["field initializer", error.replace("readonly failure: string;", 'readonly failure = "changed";') + use],
    ["static field", error.replace("readonly failure", "static readonly failure") + use],
    ["static block", error.replace("readonly failure", 'static { console.log("effect"); } readonly failure') + use],
    ["inherited custom behavior", error.replace("extends Error", "extends TypeError") + use],
    ["extra method", error.replace("readonly failure", 'run() { return 1; } readonly failure') + use],
    ["getter", error.replace("readonly failure", 'get value() { return 1; } readonly failure') + use],
    ["constructor branch", error.replace('this.failure = failure;', 'if (failure) { this.failure = failure; }') + use],
    ["transformed payload", error.replace('this.failure = failure;', 'this.failure = failure.toUpperCase();') + use],
    ["renamed error identity", error.replace('this.name = "DataError"', 'this.name = "OtherError"') + use],
    ["additional constructor effect", error.replace('this.name =', 'console.log(failure); this.name =') + use],
    ["computed field assignment", error.replace('this.failure =', 'this["failure"] =') + use],
    ["extra assignment", error.replace('this.failure = failure;', 'this.failure = failure; this.name = "DataError";') + use],
    ["constructor default", error.replace('constructor(failure: string)', 'constructor(failure = "implicit")') + use],
    ["constructor alias", error + 'export function compare() { const Constructor = DataError; throw new Constructor("invalid"); }'],
    ["constructor mutation", error + 'export function compare() { DataError.prototype.name = "changed"; return 1; }'],
    ["constructor escape", error + 'export function compare() { return DataError; }'],
    ["instance escape", error + 'export function compare() { return new DataError("invalid"); }'],
    ["shadowed Error superclass", 'function Error(_message: string) {} ' + error + use],
    ["ambient superclass alias", 'const Base = Error; ' + error.replace('extends Error', 'extends Base') + use],
    ["ambient failure message", error + 'export function compare() { throw new DataError(String(Date.now())); }']
  ]) {test(`primitive error rejects ${name}`, async (t) => {
    const f = await primitiveFixture(t); await f.write(f.record.path, source); await rejects(f, "impure-primitive");
  });}
}
