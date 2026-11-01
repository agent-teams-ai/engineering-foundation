// Startup proof only: no filesystem interception or test-source mutation.
const entry = process.argv[1]?.endsWith("format-files.test.ts") ? "literal"
  : process.argv[1]?.endsWith("command-host-successor-cli.test.mts") ? "witness" : "other";
process.stderr.write(JSON.stringify({ diagnostic: "focused-preload-start", entry, pid: process.pid,
  platform: process.platform, node: process.version }) + "\n");
