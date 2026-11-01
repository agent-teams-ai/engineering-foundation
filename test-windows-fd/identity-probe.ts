// Native Windows evidence only. No provider/process execution or OS spoofing.
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = fs.mkdtempSync(join(tmpdir(), "TEST-pr457-fd-"));
const rows: unknown[] = [];
const numeric = new Set<string>(), exact = new Set<string>();
try {
  for (let index = 0; index < 220; index++) {
    const file = join(root, `${String(index).padStart(3, "0")}${"x".repeat(120)}.json`);
    fs.writeFileSync(file, "{}\n");
    const fd = fs.openSync(file, fs.constants.O_RDONLY);
    try {
      const a = fs.fstatSync(fd), b = fs.fstatSync(fd, { bigint: true });
      const c = fs.lstatSync(file), d = fs.lstatSync(file, { bigint: true });
      const numberKey = `${a.dev}:${a.ino}`, exactKey = `${b.dev}:${b.ino}`;
      if (index < 3 || numeric.has(numberKey) || a.dev !== c.dev || a.ino !== c.ino) {
        if (rows.length < 16) rows.push({ index, pathLength: file.length,
          fstat: { dev: a.dev, ino: a.ino, safe: Number.isSafeInteger(a.ino), size: a.size },
          lstat: { dev: c.dev, ino: c.ino, safe: Number.isSafeInteger(c.ino), size: c.size },
          fstatExact: { dev: String(b.dev), ino: String(b.ino) },
          lstatExact: { dev: String(d.dev), ino: String(d.ino) } });
      }
      numeric.add(numberKey); exact.add(exactKey);
    } finally { fs.closeSync(fd); }
  }
  const selected = join(root, "selected.json"), replacement = join(root, "replacement.json");
  fs.writeFileSync(selected, "{}\n"); fs.writeFileSync(replacement, "[]\n");
  const fd = fs.openSync(selected, fs.constants.O_RDONLY);
  let rename: unknown;
  try {
    try { fs.renameSync(replacement, selected); rename = { outcome: "renamed" }; }
    catch (error) { const value = error !== null && typeof error === "object" ? error : {};
      rename = { outcome: "refused", code: "code" in value ? String(value.code) : null,
        syscall: "syscall" in value ? String(value.syscall) : null }; }
  } finally { fs.closeSync(fd); }
  assert.equal(exact.size > 0, true);
  process.stdout.write(JSON.stringify({ diagnostic: "native-fd-identity", platform: process.platform,
    node: process.version, files: 220, numericUnique: numeric.size, exactUnique: exact.size, rows, rename }) + "\n");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
