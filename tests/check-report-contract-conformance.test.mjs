import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
);
const schemaPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "schemas",
  "foundation-check-report",
  "v1.schema.json",
);

function schemaType(schema, root, referenceStack = []) {
  if (schema.$ref !== undefined) {
    const prefix = "#/$defs/";
    assert.ok(schema.$ref.startsWith(prefix), `unsupported schema reference: ${schema.$ref}`);
    const name = schema.$ref.slice(prefix.length);
    assert.ok(!referenceStack.includes(name), `recursive schema reference: ${schema.$ref}`);
    assert.ok(root.$defs[name] !== undefined, `missing schema definition: ${name}`);
    return schemaType(root.$defs[name], root, [...referenceStack, name]);
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  if (schema.enum !== undefined) {
    return schema.enum.map(JSON.stringify).join(" | ");
  }
  if (schema.type === "array") {
    return `readonly (${schemaType(schema.items, root, referenceStack)})[]`;
  }
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, "schema objects must remain closed");
    const required = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties ?? {})
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, propertySchema]) => {
        const optional = required.has(name) ? "" : "?";
        return `readonly ${JSON.stringify(name)}${optional}: ${schemaType(propertySchema, root, referenceStack)};`;
      });
    return `{ ${properties.join(" ")} }`;
  }
  if (schema.type === "integer" || schema.type === "number") {
    return "number";
  }
  if (["boolean", "string"].includes(schema.type)) {
    return schema.type;
  }
  assert.fail(`unsupported schema shape: ${JSON.stringify(schema)}`);
}

test("FoundationCheckReport is structurally exhaustive with its released v1 schema", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const temporaryRoot = await mkdtemp(join(repositoryRoot, ".foundation-report-conformance-"));
  const sourcePath = join(temporaryRoot, "contract-conformance.ts");
  const declarationPath = join(distRoot, "check-contract.js");
  const relativeDeclarationPath = relative(temporaryRoot, declarationPath).split(sep).join("/");
  const declarationSpecifier = relativeDeclarationPath.startsWith(".")
    ? relativeDeclarationPath
    : `./${relativeDeclarationPath}`;
  const source = [
    `import type { FoundationCheckReport } from ${JSON.stringify(declarationSpecifier)};`,
    `type SchemaReport = ${schemaType(schema, schema)};`,
    "type Equal<Left, Right> =",
    "  (<Value>() => Value extends Left ? 1 : 2) extends",
    "  (<Value>() => Value extends Right ? 1 : 2)",
    "    ? (<Value>() => Value extends Right ? 1 : 2) extends",
    "        (<Value>() => Value extends Left ? 1 : 2)",
    "      ? true",
    "      : false",
    "    : false;",
    "type Assert<Condition extends true> = Condition;",
    "type CheckReportSchemaConformance = Assert<Equal<FoundationCheckReport, SchemaReport>>;",
    "export type { CheckReportSchemaConformance };",
    "",
  ].join("\n");

  try {
    await writeFile(sourcePath, source, "utf8");
    await execFileAsync(process.execPath, [
      join(repositoryRoot, "node_modules", "typescript", "lib", "tsc.js"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2024",
      sourcePath,
    ]);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
