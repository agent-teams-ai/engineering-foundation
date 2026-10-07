/** Fixed private child program. fd 3 carries a single handshake, fd 4 releases execution. */
import { readSync, writeSync } from "node:fs";
const [kind, entry] = process.argv.slice(2);
const payload = JSON.stringify({ execPath: process.execPath, version: process.versions.node,
  platform: process.platform, architecture: process.arch });
writeSync(3, `${payload}\n`);
const release = Buffer.alloc(1);
if (readSync(4, release, 0, 1, null) !== 1 || release[0] !== 49) {process.exit(74);}
if (kind === "node-identity") {process.exit(0);}
if (entry === undefined || entry === "" || kind === undefined || kind === "" ||
    !["pnpm-version", "pnpm-install-prepare", "pnpm-install-frozen-offline", "pnpm-peers-check"].includes(kind)) {process.exit(74);}
const store = `${process.cwd()}/.managed-pnpm-store`;
process.argv = kind === "pnpm-version" ? [process.execPath, entry, "--version"] :
  kind === "pnpm-peers-check" ? [process.execPath, entry, "peers", "check", "--lockfile-only"] :
  [process.execPath, entry, "install", "--ignore-scripts", "--engine-strict",
    "--strict-peer-dependencies", "--config.auto-install-peers=false",
    "--config.manage-package-manager-versions=false", "--config.verify-store-integrity=true",
    "--package-import-method=copy", `--store-dir=${store}`, "--offline",
    ...(kind === "pnpm-install-frozen-offline" ? ["--frozen-lockfile"] : [])];
await import(entry);
