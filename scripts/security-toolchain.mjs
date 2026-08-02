import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AQUA_VERSION,
  AquaExecutableChecksumMismatchError,
  downloadAquaArtifact,
  extractAquaExecutable,
  SecurityToolchainError,
  selectAquaArtifact,
  verifyAquaArchiveChecksum,
  verifyAquaExecutableChecksum
} from "./security-toolchain-artifact.mjs";

const execFileAsync = promisify(execFile);

const CACHE_DIRECTORY_NAME = "agent-teams-engineering-foundation";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_STALE_AFTER_MS = 300_000;
const LOCK_RETRY_MS = 100;
const VERSION_TIMEOUT_MS = 10_000;

function isErrorCode(error, code) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function absoluteDirectory(path, label) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_INVALID_CACHE_PATH",
      label + " must be an absolute path."
    );
  }
  return resolvePath(path);
}

export function resolveToolchainCacheDirectory({
  cacheDirectory,
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform
} = {}) {
  if (cacheDirectory !== undefined) {
    return absoluteDirectory(cacheDirectory, "Security toolchain cache directory");
  }
  const configuredDirectory = environment.FOUNDATION_SECURITY_TOOLCHAIN_CACHE_DIR;
  if (configuredDirectory !== undefined) {
    return absoluteDirectory(
      configuredDirectory,
      "FOUNDATION_SECURITY_TOOLCHAIN_CACHE_DIR"
    );
  }
  if (platform === "linux" && environment.XDG_CACHE_HOME !== undefined) {
    return join(absoluteDirectory(environment.XDG_CACHE_HOME, "XDG_CACHE_HOME"), CACHE_DIRECTORY_NAME);
  }
  const cacheParent =
    platform === "darwin"
      ? join(homeDirectory, "Library", "Caches")
      : join(homeDirectory, ".cache");
  return join(absoluteDirectory(cacheParent, "User cache directory"), CACHE_DIRECTORY_NAME);
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_UNSAFE_CACHE_PATH",
      "Security toolchain cache path is not a regular directory: " + path + "."
    );
  }
  if (process.platform !== "win32") {
    await chmod(path, 0o700);
  }
}

function outputHasPinnedAquaVersion(output) {
  return new RegExp(
    "(?:^|[^0-9A-Za-z.+-])(?:v)?" +
      AQUA_VERSION.replaceAll(".", "\\.") +
      "(?:$|[^0-9A-Za-z.+-])",
    "u"
  ).test(output);
}

async function reportsPinnedAquaVersion(executable, { timeoutMs = VERSION_TIMEOUT_MS } = {}) {
  try {
    const { stderr, stdout } = await execFileAsync(executable, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true
    });
    return outputHasPinnedAquaVersion(stdout + stderr);
  } catch {
    return false;
  }
}

async function hasExpectedAquaExecutable(path, artifact) {
  try {
    verifyAquaExecutableChecksum(await readFile(path), artifact);
    return true;
  } catch (error) {
    if (error instanceof AquaExecutableChecksumMismatchError) {
      return false;
    }
    if (isErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function isUsableCachedAqua(path, artifact, validateAqua) {
  try {
    const status = await lstat(path);
    return (
      status.isFile() &&
      !status.isSymbolicLink() &&
      (await hasExpectedAquaExecutable(path, artifact)) &&
      (await validateAqua(path))
    );
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function removeCachedExecutable(path) {
  try {
    const status = await lstat(path);
    if (!status.isFile() && !status.isSymbolicLink()) {
      throw new SecurityToolchainError(
        "SECURITY_TOOLCHAIN_UNSAFE_CACHE_PATH",
        "Cached Aqua executable path is not a file: " + path + "."
      );
    }
    await unlink(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function removeTemporaryDirectory(path, executable) {
  try {
    await unlink(executable);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  try {
    await rmdir(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function pause(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function parseLockOwner(value) {
  try {
    const owner = JSON.parse(value);
    if (
      typeof owner === "object" &&
      owner !== null &&
      typeof owner.processId === "number" &&
      typeof owner.token === "string"
    ) {
      return owner;
    }
  } catch {
    return;
  }
  return;
}

function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
}

async function discardStaleLock(lockPath, staleAfterMs) {
  let status;
  try {
    status = await lstat(lockPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new SecurityToolchainError(
      "SECURITY_TOOLCHAIN_UNSAFE_LOCK_PATH",
      "Security toolchain lock path is not a regular directory: " + lockPath + "."
    );
  }
  if (Date.now() - status.mtimeMs < staleAfterMs) {
    return;
  }
  let entries;
  try {
    entries = await readdir(lockPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const ownerPath = join(lockPath, "owner");
  if (entries.length === 1 && entries[0] === "owner") {
    let owner;
    try {
      owner = parseLockOwner(await readFile(ownerPath, "utf8"));
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    if (owner !== undefined && isProcessAlive(owner.processId)) {
      return;
    }
    try {
      await unlink(ownerPath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
  } else if (entries.length !== 0) {
    return;
  }
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT") && !isErrorCode(error, "ENOTEMPTY")) {
      throw error;
    }
  }
}

async function releaseBootstrapLock(lockPath, owner) {
  const ownerPath = join(lockPath, "owner");
  try {
    if (parseLockOwner(await readFile(ownerPath, "utf8"))?.token !== owner) {
      return;
    }
    await unlink(ownerPath);
    await rmdir(lockPath);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT") && !isErrorCode(error, "ENOTEMPTY")) {
      throw error;
    }
  }
}

async function acquireLock(
  lockPath,
  {
    retryMs = LOCK_RETRY_MS,
    staleAfterMs = LOCK_STALE_AFTER_MS,
    timeoutMs = LOCK_TIMEOUT_MS
  } = {}
) {
  const owner = randomUUID();
  const ownerPath = join(lockPath, "owner");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw error;
      }
      await discardStaleLock(lockPath, staleAfterMs);
      await pause(retryMs);
      continue;
    }
    try {
      await writeFile(
        ownerPath,
        JSON.stringify({ processId: process.pid, token: owner }),
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600
        }
      );
    } catch (error) {
      await unlink(ownerPath).catch(() => {});
      await rmdir(lockPath).catch(() => {});
      throw error;
    }
    return () => releaseBootstrapLock(lockPath, owner);
  }
  throw new SecurityToolchainError(
    "SECURITY_TOOLCHAIN_LOCK_TIMEOUT",
    "Timed out waiting for the pinned Aqua bootstrap lock."
  );
}

async function installPinnedAqua({
  artifact,
  cacheDirectory,
  download,
  downloadTimeoutMs,
  executable,
  extract,
  validateAqua
}) {
  const stageDirectory = await mkdtemp(join(cacheDirectory, ".aqua-stage-"));
  const stagedExecutable = join(stageDirectory, "aqua");
  try {
    const archive = await download(artifact, { timeoutMs: downloadTimeoutMs });
    verifyAquaArchiveChecksum(archive, artifact);
    await extract(archive, stagedExecutable);
    await chmod(stagedExecutable, 0o700);
    verifyAquaExecutableChecksum(await readFile(stagedExecutable), artifact);
    if (!(await validateAqua(stagedExecutable))) {
      throw new SecurityToolchainError(
        "SECURITY_TOOLCHAIN_INVALID_BINARY",
        "Downloaded Aqua does not report pinned version " + AQUA_VERSION + "."
      );
    }
    await ensurePrivateDirectory(dirname(executable));
    await removeCachedExecutable(executable);
    await rename(stagedExecutable, executable);
    if (!(await isUsableCachedAqua(executable, artifact, validateAqua))) {
      await removeCachedExecutable(executable);
      throw new SecurityToolchainError(
        "SECURITY_TOOLCHAIN_INVALID_BINARY",
        "Installed Aqua does not report pinned version " + AQUA_VERSION + "."
      );
    }
  } finally {
    await removeTemporaryDirectory(stageDirectory, stagedExecutable);
  }
}

export async function ensurePinnedAqua(options = {}) {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const artifact = options.artifact ?? selectAquaArtifact({ architecture, platform });
  const cacheDirectory = resolveToolchainCacheDirectory({
    cacheDirectory: options.cacheDirectory,
    environment: options.environment,
    homeDirectory: options.homeDirectory,
    platform
  });
  const validateAqua = options.validateAqua ?? reportsPinnedAquaVersion;
  const download = options.download ?? downloadAquaArtifact;
  const extract = options.extract ?? extractAquaExecutable;
  await ensurePrivateDirectory(cacheDirectory);
  const installationDirectory = join(
    cacheDirectory,
    "aqua",
    "v" + AQUA_VERSION,
    platform + "-" + architecture
  );
  const executable = join(installationDirectory, "aqua");
  if (await isUsableCachedAqua(executable, artifact, validateAqua)) {
    return { cacheDirectory, executable };
  }
  await ensurePrivateDirectory(join(cacheDirectory, "locks"));
  const unlockAqua = await acquireLock(
    join(cacheDirectory, "locks", "aqua-v" + AQUA_VERSION + "-" + platform + "-" + architecture),
    options.lock
  );
  try {
    if (!(await isUsableCachedAqua(executable, artifact, validateAqua))) {
      await installPinnedAqua({
        artifact,
        cacheDirectory,
        download,
        downloadTimeoutMs: options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
        executable,
        extract,
        validateAqua
      });
    }
    return { cacheDirectory, executable };
  } finally {
    await unlockAqua();
  }
}

function executeAqua(executable, arguments_, { cwd, environment }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      env: environment,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", (error) => {
      reject(
        new SecurityToolchainError(
          "SECURITY_TOOLCHAIN_COMMAND_FAILED",
          "Unable to run pinned Aqua.",
          { cause: error }
        )
      );
    });
    child.once("exit", (status, signal) => {
      if (status === 0) {
        resolve();
        return;
      }
      reject(
        new SecurityToolchainError(
          "SECURITY_TOOLCHAIN_COMMAND_FAILED",
          "Pinned Aqua command failed" +
            (signal === null ? " with exit code " + String(status) : " from signal " + signal) +
            "."
        )
      );
    });
  });
}

export async function runWorkflowSecurityTools(options = {}) {
  const bootstrap = await ensurePinnedAqua(options);
  const aquaRootDirectory = join(bootstrap.cacheDirectory, "aqua-runtime");
  await ensurePrivateDirectory(aquaRootDirectory);
  const environment = {
    ...process.env,
    ...options.environment,
    AQUA_ENFORCE_CHECKSUM: "true",
    AQUA_ENFORCE_REQUIRE_CHECKSUM: "true",
    AQUA_ROOT_DIR: aquaRootDirectory
  };
  const executionOptions = {
    cwd: options.cwd ?? process.cwd(),
    environment
  };
  await executeAqua(bootstrap.executable, ["exec", "--", "actionlint"], executionOptions);
  await executeAqua(
    bootstrap.executable,
    [
      "exec",
      "--",
      "zizmor",
      "--offline",
      "--strict-collection",
      "--persona",
      "pedantic",
      "--min-severity",
      "medium",
      "--min-confidence",
      "medium",
      "."
    ],
    executionOptions
  );
}

function isEntrypoint() {
  const invokedPath = process.argv[1];
  return (
    invokedPath !== undefined &&
    fileURLToPath(import.meta.url) === resolvePath(invokedPath)
  );
}

if (isEntrypoint()) {
  try {
    await runWorkflowSecurityTools();
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
