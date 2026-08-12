import { readFile } from "node:fs/promises";

const [journalPath] = process.argv.slice(2);
if (journalPath === undefined) {
  throw new Error("journal path is required");
}

const source = await readFile(journalPath, "utf8");
const value = JSON.parse(source);
if (value?.schemaVersion !== 1) {
  process.stderr.write(
    "SCAFFOLD_RECOVERY_REQUIRED: A released 0.5 scaffolding journal must be recovered before upgrading.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write("LEGACY_SCAFFOLD_JOURNAL_V1\n");
}
