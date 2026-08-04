import { spawn } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";

const [pidPath] = process.argv.slice(2);
if (pidPath === undefined) {
  throw new Error("pid path is required");
}

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000);"], {
  stdio: "ignore"
});

const temporaryPidPath = `${pidPath}.${process.pid}.tmp`;
await writeFile(
  temporaryPidPath,
  `${JSON.stringify({ parent: process.pid, child: child.pid })}\n`,
  "utf8"
);
await rename(temporaryPidPath, pidPath);
process.stdout.write("READY\n");
setInterval(() => {}, 60_000);
