import assert from "node:assert/strict";
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
  assert.equal(findings[0].ruleId, "quality.source-coverage.explicit-unknown");
  await writeFile(join(root, path), "type Alias = string; const value = <Alias>(<unknown>1);");
  assert.equal((await scan()).length, 1);
});
