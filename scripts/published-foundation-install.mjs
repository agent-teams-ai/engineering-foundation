import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const packageName = "@agent-teams/engineering-foundation";

export async function installPublishedFoundation({
  expectedIntegrity,
  installPackage,
  root,
  version,
}) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "published-foundation-qualification",
        private: true,
        type: "module",
        devDependencies: { [packageName]: version },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await installPackage(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=true",
      "--registry=https://registry.npmjs.org/",
      "--loglevel=error",
    ],
    root,
  );
  const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const locked = lockfile.packages?.[`node_modules/${packageName}`];
  if (
    locked?.version !== version ||
    locked.integrity !== expectedIntegrity ||
    typeof locked.resolved !== "string" ||
    !locked.resolved.startsWith("https://registry.npmjs.org/")
  ) {
    throw new Error(`Published Foundation ${version} did not match pinned npm evidence.`);
  }
  const packageRoot = join(root, "node_modules", "@agent-teams", "engineering-foundation");
  const metadata = await lstat(packageRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Published Foundation ${version} did not install as a real directory.`);
  }
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== packageName || manifest.version !== version) {
    throw new Error(`Published Foundation ${version} has the wrong package identity.`);
  }
  return Object.freeze({
    cliPath: join(packageRoot, "dist", "cli.js"),
    packageRoot,
  });
}
