// Two real native controls, independent of formatter observations.
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = fs.mkdtempSync(join(tmpdir(), "TEST-pr457-rename-"));
const rows: { mode: string; outcome: string; code?: string; stage?: string; originalDescriptorBytes?: string }[] = [];
try {
  for (const mode of ["overwrite-open", "rename-aside-then-replace"]) {
    const directory = join(root, mode); fs.mkdirSync(directory);
    const selected = join(directory, "selected.json"), replacement = join(directory, "new.json");
    fs.writeFileSync(selected, "{}\n"); fs.writeFileSync(replacement, "[]\n");
    const fd = fs.openSync(selected, fs.constants.O_RDONLY);
    let stage = "overwrite";
    try {
      if (mode === "rename-aside-then-replace") { stage = "aside"; fs.renameSync(selected, join(directory, "held.json")); stage = "replace"; }
      fs.renameSync(replacement, selected);
      stage = "descriptor-verification";
      const bytes = Buffer.alloc(3); assert.equal(fs.readSync(fd, bytes, 0, 3, 0), 3);
      assert.equal(bytes.toString(), "{}\n"); assert.equal(fs.readFileSync(selected, "utf8"), "[]\n");
      rows.push({ mode, outcome: "renamed", originalDescriptorBytes: "original" });
    } catch (error) {
      const value = error !== null && typeof error === "object" ? error : {};
      rows.push({ mode, stage, outcome: stage === "descriptor-verification" ? "verification-failed" : "refused", code: "code" in value ? String(value.code) : "UNKNOWN" });
    } finally { fs.closeSync(fd); }
  }
  process.stdout.write(JSON.stringify({ diagnostic: "two-native-rename-controls", platform: process.platform, node: process.version,
    rows, asideSupported: rows.some(r => r.mode === "rename-aside-then-replace" && r.outcome === "renamed") }) + "\n");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
