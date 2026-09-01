import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function commandShim(root, name, { posix, windows }, platform = process.platform) {
  const isWindows = platform === "win32";
  const path = join(root, "bin", `${name}${isWindows ? ".cmd" : ""}`);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "home", "global.npmrc"), ""),
    writeFile(join(root, "home", "user.npmrc"), ""),
  ]);
  await writeFile(path, isWindows ? windows : posix);
  if (!isWindows) {
    await chmod(path, 0o755);
  }
  return path;
}

export function commandEnvironment(
  root,
  publishMarker,
  platform = process.platform,
  baseEnvironment = process.env,
) {
  const environment = Object.fromEntries(
    Object.entries(baseEnvironment).filter(([key]) => {
      const normalized = key.toLowerCase();
      return !["home", "homedrive", "homepath", "path", "pathext", "userprofile"].includes(normalized) &&
        !normalized.startsWith("npm_") &&
        !normalized.startsWith("pnpm_") && !normalized.startsWith("corepack_");
    }),
  );
  const isolatedHome = join(root, "home");
  environment[platform === "win32" ? "Path" : "PATH"] = join(root, "bin");
  environment.COMMAND_SHIM_MARKER = join(root, "command-shim.marker");
  environment.HOME = isolatedHome;
  environment.NPM_CONFIG_GLOBALCONFIG = join(isolatedHome, "global.npmrc");
  environment.NPM_CONFIG_USERCONFIG = join(isolatedHome, "user.npmrc");
  if (platform === "win32") {
    environment.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }
  environment.PUBLISH_MARKER = publishMarker;
  environment.USERPROFILE = isolatedHome;
  return environment;
}
