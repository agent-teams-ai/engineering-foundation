import { appendFile, readFile } from "node:fs/promises";

const [kind = "unknown", ...rawPaths] = process.argv.slice(2);
const paths = rawPaths[0] === "--" ? rawPaths.slice(1) : rawPaths;
await appendFile(
  ".fixture-invocations.jsonl",
  `${JSON.stringify({ kind, paths })}\n`,
  "utf8",
);

for (const path of paths) {
  const source = await readFile(path, "utf8");
  if (source.includes("FAIL_FIXTURE")) {
    process.stderr.write(`fixture violation: ${path}\n`);
    process.exitCode = 1;
  }
}
