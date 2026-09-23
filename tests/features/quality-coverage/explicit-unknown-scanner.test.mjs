import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectExplicitUnknown } from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/consumer-execution.js";
import { readContainedRegularFile } from "../../../packages/engineering-foundation/dist/source-inventory/node.js";

test("contained OXC scan rejects unreadable and unparseable production sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ef-331-scan-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  const path = "src/main.ts";
  const scan = () => inspectExplicitUnknown({ consumerRoot: root, paths: [path], read: readContainedRegularFile });
  await assert.rejects(scan(), /Contained file read failed/u);
  await writeFile(join(root, path), "const value = (;");
  await assert.rejects(scan(), /could not parse/u);
  await writeFile(join(root, path), "type Alias = string; const value = ((1 as /* bridge */ unknown)!) satisfies unknown as Alias;");
  const findings = await scan();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, path);
  assert.match(findings[0].sha256, /^[a-f0-9]{64}$/u);
  await writeFile(join(root, path), "type Alias = string; const value = <Alias>(<unknown>1);");
  assert.equal((await scan()).length, 1);
});

test("scanner uses UTF-16 source identity across TS extensions and ignores widening to unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ef-331-offset-TEST-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  const expression = '(("😀" as (unknown))) as string';
  const source = `const café = "😀"; export const value = ${expression};`;
  const start = source.indexOf(expression);
  const bridge = { path: "src/main.mts", start, end: start + expression.length,
    sha256: createHash("sha256").update(expression).digest("hex"),
    rationale: "Exact Unicode bridge identity with rejection evidence.", rejectingTest: "evidence/bridge-proof.json" };
  await mkdir(join(root, "evidence"));
  await writeFile(join(root, bridge.rejectingTest), "{}");
  for (const path of ["src/main.ts", "src/main.tsx", "src/main.mts", "src/main.cts", "src/main.d.ts", "src/main.d.mts", "src/main.d.cts"]) {
    const text = path.includes(".d.") ? `declare const value: string;\n${source}` : source;
    await writeFile(join(root, path), text);
    const expectedStart = text.indexOf(expression);
    const findings = await inspectExplicitUnknown({ consumerRoot: root, paths: [path], read: readContainedRegularFile });
    assert.equal(findings.length, 1, path);
    assert.deepEqual(findings[0], { path, start: expectedStart, end: expectedStart + expression.length, sha256: bridge.sha256 });
  }
  assert.deepEqual(await inspectExplicitUnknown({ consumerRoot: root, paths: [bridge.path], read: readContainedRegularFile,
    admissionValue: { schemaVersion: 1, bridges: [bridge] } }), []);
  await assert.rejects(inspectExplicitUnknown({ consumerRoot: root, paths: [bridge.path], read: readContainedRegularFile,
    admissionValue: { schemaVersion: 1, bridges: [{ ...bridge, start: start + 1 }] } }), /Stale or unmatched/u);
  await writeFile(join(root, bridge.path), 'export const value = (1 as unknown) as unknown;');
  assert.deepEqual(await inspectExplicitUnknown({ consumerRoot: root, paths: [bridge.path], read: readContainedRegularFile }), []);
});
