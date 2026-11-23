import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const contract = fileURLToPath(new URL("../src/features/eslint-syntax/rule-contract.ts", import.meta.url));
const prelude = `import type { RuleContext, RuleListener } from ${JSON.stringify(contract)};\ndeclare const context: RuleContext<"known", []>;\n`;

void test("strict native compilation admits the public host contract and rejects malformed authoring", () => {
  const manifest = require.resolve("typescript/package.json");
  const metadata: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  assert.ok(metadata !== null && typeof metadata === "object" && "version" in metadata);
  assert.equal(metadata.version, "7.0.2");
  const root = mkdtempSync(join(tmpdir(), "TEST-eslint-types-"));
  try {
    symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const publicEntry = fileURLToPath(new URL("../dist/eslint-syntax.js", import.meta.url));
    writeFileSync(join(root, "positive.ts"), prelude + `
      import { configs, parser, plugin } from ${JSON.stringify(publicEntry)};
      import type { Linter } from "eslint";
      const configuration: Linter.Config[] = [...configs.recommended, { languageOptions: { parser }, plugins: { retained: plugin } }];
      context.report({ node: context.sourceCode.ast, messageId: "known", fix(fixer) { return fixer.insertTextAfter(context.sourceCode.ast, "\\n"); } });
      const listeners: RuleListener = { TSAnyKeyword(node) { context.report({ node, messageId: "known" }); } };
      void configuration; void listeners;
    `);
    const compiler = join(dirname(manifest), "bin/tsc");
    const compile = (files: string[]) => {
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ files, compilerOptions: {
        target: "ES2024", module: "NodeNext", strict: true, noEmit: true,
        exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
        noImplicitOverride: true, noImplicitReturns: true, noPropertyAccessFromIndexSignature: true,
        allowImportingTsExtensions: true, types: ["node"], skipLibCheck: false,
      } }));
      const result = spawnSync(process.execPath, [compiler, "-p", join(root, "tsconfig.json"), "--pretty", "false"], {
        encoding: "utf8", timeout: 30_000, env: { ...process.env, GOMAXPROCS: "2", GOMEMLIMIT: "512MiB" },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    };
    const positive = compile(["positive.ts"]);
    assert.equal(positive.status, 0, positive.stdout + positive.stderr);
    const negatives = {
      "message-id.ts": 'context.report({ node: context.sourceCode.ast, messageId: "unknown" });',
      "missing-location.ts": 'context.report({ messageId: "known" });',
      "bad-fix.ts": 'context.report({ node: context.sourceCode.ast, messageId: "known", fix() { return "wrong"; } });',
      "wrong-node.ts": 'const listeners: RuleListener = { TSAnyKeyword(node) { void node.name; } }; void listeners;',
      "wrong-token.ts": 'const token = context.sourceCode.getFirstToken(context.sourceCode.ast); if (token) void token.absent;',
      "wrong-scope.ts": 'void context.sourceCode.getScope(context.sourceCode.ast).program;',
    };
    for (const [name, body] of Object.entries(negatives)) writeFileSync(join(root, name), prelude + body);
    const negative = compile(Object.keys(negatives));
    assert.notEqual(negative.status, 0);
    for (const name of Object.keys(negatives)) assert.ok(negative.stdout.includes(`${name}(`), negative.stdout);
    assert.equal((negative.stdout.match(/error TS\d+/gu) ?? []).length, Object.keys(negatives).length, negative.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
