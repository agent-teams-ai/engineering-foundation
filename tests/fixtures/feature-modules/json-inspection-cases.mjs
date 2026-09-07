import test from "node:test";

export function registerJsonInspectionCases(primitiveFixture, expectPass, rejects) {
  for (const [name, source] of [
    ["fresh Set", "const values = new Set<string>(); values.add('a'); return values.has('a');"],
    ["fresh WeakSet", "const values = new WeakSet<object>(); const value = {}; values.add(value); return values.has(value);"],
    ["direct prototype comparison", "return Object.getPrototypeOf([]) === Array.prototype;"],
    ["reverse prototype comparison", "return Object.prototype !== Object.getPrototypeOf([]);"],
    ["local prototype comparison", "const value = {}; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null;"],
    ["wrapped prototype comparison", "const value = {}; const prototype = (Object.getPrototypeOf(value) as unknown); return Object.prototype === (prototype as object);"],
    ["explicit descriptor inspection", "const value = {a: 1}; return Object.getOwnPropertyDescriptor(value, 'a')?.value;"],
    ["explicit own-key inspection", "const value = {a: 1}; return Reflect.ownKeys(value).length;"]
  ]) {
    test(`JSON primitive operations accept ${name}`, async (t) => {
      const f = await primitiveFixture(t);
      await f.write(f.record.path, `export function compare() { ${source} }`);
      await expectPass(f);
    });
  }

  for (const [name, source] of [
    ["module Set", "const values = new Set(); export function compare() { return values.size; }"],
    ["module WeakSet", "const values = new WeakSet(); export function compare() { return values; }"],
    ["Set constructor alias", "export function compare() { const Constructor = Set; return new Constructor(); }"],
    ["Set iterable argument", "export function compare(value: Iterable<string>) { return new Set(value); }"],
    ["WeakSet iterable argument", "export function compare(value: Iterable<object>) { return new WeakSet(value); }"],
    ["Set spread argument", "export function compare(...args: []) { return new Set(...args); }"],
    ["Map constructor", "export function compare() { return new Map(); }"],
    ["collection constructor escape", "export function compare() { return Set; }"],
    ["collection prototype escape", "export function compare() { return Set.prototype; }"],
    ["collection prototype write", "export function compare() { Set.prototype.add = () => null; return 1; }"],
    ["prototype result escape", "export function compare(value: object) { return Object.getPrototypeOf(value); }"],
    ["prototype local escape", "export function compare(value: object) { const prototype = Object.getPrototypeOf(value); return prototype; }"],
    ["prototype property write", "export function compare(value: object) { const prototype = Object.getPrototypeOf(value); prototype.flag = 1; return 1; }"],
    ["prototype local alias", "export function compare(value: object) { const prototype = Object.getPrototypeOf(value); const alias = prototype; return alias === Object.prototype; }"],
    ["prototype capture", "export function compare(value: object) { const prototype = Object.getPrototypeOf(value); return () => prototype === Object.prototype; }"],
    ["intrinsic prototype escape", "export function compare() { return Object.prototype; }"],
    ["intrinsic prototype alias", "export function compare() { const prototype = Array.prototype; return prototype; }"],
    ["intrinsic prototype mutation", "export function compare() { Object.prototype.flag = 1; return 1; }"],
    ["prototype unrelated equality", "export function compare(value: object) { return Object.prototype === value; }"],
    ["prototype loose equality", "export function compare(value: object) { return Object.getPrototypeOf(value) == Object.prototype; }"],
    ["prototype descriptor lookup", "export function compare() { return Object.getOwnPropertyDescriptor(Object.prototype, 'constructor'); }"],
    ["prototype observation missing input", "export function compare() { return Object.getPrototypeOf() === Object.prototype; }"],
    ["prototype observation extra input", "export function compare() { return Object.getPrototypeOf({}, {}) === Object.prototype; }"],
    ["optional inspection", "export function compare(value: object) { return Reflect.ownKeys?.(value); }"],
    ["spread inspection", "export function compare(...args: [object]) { return Reflect.ownKeys(...args); }"],
    ["descriptor missing key", "export function compare(value: object) { return Object.getOwnPropertyDescriptor(value); }"],
    ["descriptor extra argument", "export function compare(value: object) { return Object.getOwnPropertyDescriptor(value, 'a', {}); }"],
    ["own keys missing input", "export function compare() { return Reflect.ownKeys(); }"],
    ["own keys extra input", "export function compare() { return Reflect.ownKeys({}, {}); }"],
    ["inspection callable escape", "export function compare() { return Reflect.ownKeys; }"],
    ["inspection of ambient container", "export function compare() { return Reflect.ownKeys(globalThis); }"],
    ["inspection of module state", "const state = {count: 0}; export function compare() { return Object.getOwnPropertyDescriptor(state, 'count'); }"],
    ["unsafe prototype mutation", "export function compare(value: object) { return Object.setPrototypeOf(value, null); }"],
    ["unsafe reflect read", "export function compare(value: object) { return Reflect.get(value, 'a'); }"]
  ]) {
    test(`JSON primitive operations reject ${name}`, async (t) => {
      const f = await primitiveFixture(t);
      await f.write(f.record.path, source);
      await rejects(f, "impure-primitive");
    });
  }
}
