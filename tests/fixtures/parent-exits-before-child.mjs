import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const [pidPath] = process.argv.slice(2);
if (pidPath === undefined) {
  throw new Error("pid path is required");
}

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000);"], {
  stdio: ["ignore", "inherit", "inherit"]
});
child.unref();

await writeFile(
  pidPath,
  `${JSON.stringify({ parent: process.pid, child: child.pid })}\n`,
  "utf8"
);
