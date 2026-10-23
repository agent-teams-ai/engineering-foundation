import { appendFileSync } from "node:fs";

const mode = process.argv[2];
appendFileSync("invocations.txt", `${mode}:${process.argv.slice(3).join(" ")}\n`);
switch (mode) {
  case "pass":
    break;
  case "diagnostics":
    console.log("source.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.");
    process.exitCode = 2;
    break;
  case "diagnostics-timeout":
    console.log("source.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.");
    setTimeout(() => {}, 60_000);
    break;
  case "unknown":
    process.exitCode = 2;
    break;
  case undefined:
  default:
    throw new Error("Unrecognized TEST checker mode");
}
