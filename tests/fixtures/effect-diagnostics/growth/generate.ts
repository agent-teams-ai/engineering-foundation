import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const featureName = (index: number) => `f${String(index).padStart(3, "0")}`;
const predecessors = (index: number) => index === 0 ? [] : [...new Set([index - 1, Math.floor(index / 2)])].toSorted((a, b) => a - b);

async function write(directory: string, name: string, source: string) {
  const path = join(directory, name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${source}\n`);
}

/** Aggregate descriptors across feature boundaries; expectations live elsewhere. */
export async function generateGrowthSource(directory: string, size: number) {
  assert.ok([8, 100, 500, 1000].includes(size), "fixture.growth.unsupported-size");
  for (let index = 0; index < size; index += 1) {
    const name = featureName(index);
    const base = `src/features/${name}`;
    const previous = predecessors(index);
    await write(directory, `${base}/contracts/value.ts`,
      `export interface Value { readonly read: () => number; }${index === 0 ? "\nexport interface Seed { readonly read: () => number; }" : ""}`);
    await write(directory, `${base}/application/ports/value.ts`,
      "export interface ValueForRead { readonly read: () => number; }");
    const fields = index === 0 ? ["readonly seed: ValueForRead"] : previous.map(prior => `readonly p${prior}: ValueForRead`);
    const arithmetic = index === 0 ? "31 * deps.seed.read() + 1"
      : `17 * ${index + 1} + ${previous.map(prior => `${prior + 1} * deps.p${prior}.read()`).join(" + ")}`;
    await write(directory, `${base}/application/use-cases/read-value.ts`, `import type { ValueForRead } from "../ports/value.js";
export function readValue(deps: { ${fields.join("; ")} }, _input: void): number {
  return (${arithmetic}) % 1000003;
}`);
    const contract = [
      'import { defineContract } from "@get-modular/assembly";',
      'import type { CapabilitiesOf } from "@get-modular/assembly";',
      `import type { Value${index === 0 ? ", Seed" : ""} } from "../contracts/value.js";`,
      ...previous.map(prior => `import type { FeatureContracts as C${prior} } from "../../${featureName(prior)}/composition/${featureName(prior)}.contracts.js";`),
      `export const ValueContract = defineContract<Value>()({ id: "fixture/growth/${name}/value", revision: 1 });`,
    ];
    if (index === 0) { contract.push('export const SeedContract = defineContract<Seed>()({ id: "fixture/growth/seed", revision: 1 });'); }
    // Both representations use the same predecessors. Separate map bases retain
    // collision checks even for transitive contracts no factory currently uses.
    contract.push(`export type FeatureContracts = typeof ValueContract${index === 0 ? " | typeof SeedContract" : previous.map(prior => ` | C${prior}`).join("")};`,
      "export interface FeatureCapabilities extends",
      ...previous.map(prior => `  CapabilitiesOf<C${prior}>,`),
      `  CapabilitiesOf<typeof ValueContract${index === 0 ? " | typeof SeedContract" : ""}> {}`);
    await write(directory, `${base}/composition/${name}.contracts.ts`, contract.join("\n"));
    const declaration = [
      'import { required } from "@get-modular/core";',
      'import { declareModule } from "@get-modular/assembly";',
      `import { ValueContract${index === 0 ? ", SeedContract" : ""} } from "./${name}.contracts.js";`,
      ...previous.map(prior => `import { ValueContract as C${prior} } from "../../${featureName(prior)}/composition/${featureName(prior)}.contracts.js";`),
      "export const declaration = declareModule({",
      `  moduleId: "fixture/growth/${name}", implementationId: "fixture/growth/${name}/default",`,
      `  owner: { authority: "fixture", path: ["growth", "${name}"] },`,
      "  provides: [ValueContract.provide()],",
      `  slots: [${index === 0 ? 'SeedContract.slot("seed", required())' : previous.map(prior => `C${prior}.slot("p${prior}", required())`).join(", ")}],`,
      "});",
    ];
    await write(directory, `${base}/composition/value.declaration.ts`, declaration.join("\n"));
    const mappings = index === 0 ? "seed: { read: () => deps.seed.read() }"
      : previous.map(prior => `p${prior}: { read: () => deps.p${prior}.read() }`).join(", ");
    await write(directory, `${base}/composition/value.module.ts`, `import { implement } from "@get-modular/assembly";
import type { FeatureCapabilities } from "./${name}.contracts.js";
import { declaration } from "./value.declaration.js";
import { readValue } from "../application/use-cases/read-value.js";
import type { Value } from "../contracts/value.js";
export const entry = implement<FeatureCapabilities>()(declaration, async (deps) => {
  const value = readValue({ ${mappings} }, undefined);
  const port: Value = { read: () => value };
  return { instance: { value }, capabilities: { "fixture/growth/${name}/value": port } };
});`);
    await write(directory, `${base}/composition/${name}.group.ts`, `import { group } from "@get-modular/assembly";
import { entry } from "./value.module.js";
export const featureGroup = group("${name}", [entry]);`);
  }
  await write(directory, "src/features/f000/composition/input.declaration.ts", `import { declareModule } from "@get-modular/assembly";
import { SeedContract } from "./f000.contracts.js";
export const declaration = declareModule({
  moduleId: "fixture/growth/seed-input", implementationId: "fixture/growth/seed-input/default",
  owner: { authority: "fixture", path: ["growth", "f000"] },
  provides: [SeedContract.provide()], slots: [],
});`);
  await write(directory, "src/features/f000/composition/f000.inputs.ts", `import { input } from "@get-modular/assembly";
import type { FeatureCapabilities } from "./f000.contracts.js";
import { declaration } from "./input.declaration.js";
export const seedInput = input<FeatureCapabilities>()(declaration);`);
  const root = ['import type { Assembly } from "@get-modular/assembly";'];
  for (let index = 0; index < size; index += 1) {
    const name = featureName(index);
    root.push(`import { featureGroup as G${index} } from "../features/${name}/composition/${name}.group.js";`,
      `import type { FeatureCapabilities as F${index} } from "../features/${name}/composition/${name}.contracts.js";`);
  }
  root.push(`import { entry as last } from "../features/${featureName(size - 1)}/composition/value.module.js";`,
    'import { seedInput } from "../features/f000/composition/f000.inputs.js";',
    "export interface HostCapabilities extends",
    Array.from({ length: size }, (_, index) => `  F${index}`).join(",\n") + " {}",
    `export const modules: readonly [${Array.from({ length: size }, (_, index) => `typeof G${index}`).join(", ")}] = [${Array.from({ length: size }, (_, index) => `G${index}`).join(", ")}];`,
    "export const inputs = { seed: seedInput };", "export const roots = { last };",
    "export function compose(api: Assembly<HostCapabilities>) {",
    '  return api.prepare({ profileId: "fixture/growth/root", modules, roots, inputs });', "}");
  await write(directory, "src/composition/growth.root.ts", root.join("\n"));
}
