export function changesetsPublishArguments() {
  return ["changeset", "publish"];
}

export function releasePublishInvocation(options = {}) {
  const { commandInterpreter = process.env.ComSpec, platform = process.platform } = options;
  const publishArguments = changesetsPublishArguments();
  if (platform === "win32") {
    return {
      args: ["/d", "/s", "/c", `pnpm.cmd ${publishArguments.join(" ")}`],
      command: commandInterpreter ?? "cmd.exe",
    };
  }
  return { args: publishArguments, command: "pnpm" };
}
