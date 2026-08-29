import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

interface HostRequest {
  readonly schemaVersion: 1;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly launchPath: string;
}

function isHostRequest(value: unknown): value is HostRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<HostRequest>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.command === "string" &&
    candidate.command.length > 0 &&
    Array.isArray(candidate.args) &&
    candidate.args.every((argument) => typeof argument === "string") &&
    typeof candidate.cwd === "string" &&
    candidate.cwd.length > 0 &&
    typeof candidate.launchPath === "string" &&
    candidate.launchPath.length > 0
  );
}

function readRequest(): HostRequest {
  const encoded = process.argv[2];
  if (encoded === undefined) {
    throw new Error("The managed Windows process host did not receive a request.");
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("The managed Windows process host received invalid request encoding.");
  }
  if (!isHostRequest(input)) {
    throw new Error("The managed Windows process host received an invalid request.");
  }
  return input;
}

if (process.platform !== "win32") {
  process.stderr.write("The managed Windows process host can only run on Windows.\n");
  process.exitCode = 1;
} else {
  try {
    const request = readRequest();
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      detached: false,
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true
    });
    child.once("error", (error) => {
      writeFileSync(request.launchPath, "FAILED", { encoding: "utf8", flag: "wx" });
      process.stderr.write(`Managed command could not be started: ${error.message}\n`);
      process.exitCode = 1;
    });
    child.once("spawn", () => {
      try {
        writeFileSync(request.launchPath, "STARTED", { encoding: "utf8", flag: "wx" });
      } catch (error) {
        child.kill("SIGKILL");
        process.stderr.write(
          `Managed command launch could not be confirmed: ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.exitCode = 1;
      }
    });
    child.once("close", (exitCode) => {
      process.exit(exitCode ?? 1);
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
