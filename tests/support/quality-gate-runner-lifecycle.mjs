import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { watch } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";

const TEST_HARNESS_WATCHDOG_MS = 120_000;
const TEST_HARNESS_SHUTDOWN_GRACE_MS = process.platform === "win32" ? 15_000 : 5_000;
const FIXTURE_ROLE_PATTERN = /^[a-z][a-z0-9-]*$/u;
const NOOP = () => {};

function missingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function observeFixtureEffect({ read, subscribe }) {
  let closed = false;
  let queued = true;
  let reading = false;
  let unsubscribe = NOOP;
  let rejectEffect;
  let resolveEffect;
  const result = new Promise((resolve, reject) => {
    rejectEffect = reject;
    resolveEffect = resolve;
  });

  const fail = (error) => {
    if (!closed) {
      closed = true;
      unsubscribe();
      rejectEffect(error);
    }
  };
  const drain = async () => {
    if (closed || reading) {
      return;
    }
    reading = true;
    try {
      while (!closed && queued) {
        queued = false;
        try {
          const effect = await read();
          closed = true;
          unsubscribe();
          resolveEffect(effect);
        } catch (error) {
          if (!missingFile(error)) {
            fail(error);
          }
        }
      }
    } finally {
      reading = false;
    }
  };
  const notify = () => {
    if (closed) {
      return;
    }
    queued = true;
    void drain();
  };

  unsubscribe = subscribe(notify, fail);
  void drain();
  return {
    close() {
      if (!closed) {
        closed = true;
        unsubscribe();
      }
    },
    result,
  };
}

export async function waitForFixtureEffect(path, execution, parse = (source) => source) {
  const observation = observeFixtureEffect({
    read: async () => parse(await readFile(path, "utf8")),
    subscribe(notify, fail) {
      const watcher = watch(dirname(path), { persistent: false }, notify);
      watcher.once("error", fail);
      return () => { watcher.close(); };
    },
  });
  const commandClosed = execution.result.then(async (result) => {
    try {
      return parse(await readFile(path, "utf8"));
    } catch (error) {
      if (!missingFile(error)) {
        throw error;
      }
      throw new Error(`CLI exited before fixture readiness: ${JSON.stringify(result)}`, {
        cause: error,
      });
    }
  });
  try {
    return await Promise.race([observation.result, commandClosed]);
  } finally {
    observation.close();
  }
}

function createChangeSignal() {
  let waiters = [];
  return {
    notify() {
      const current = waiters;
      waiters = [];
      for (const resolve of current) {
        resolve();
      }
    },
    wait() {
      return new Promise((resolve) => { waiters.push(resolve); });
    },
  };
}

async function waitUntil(predicate, changed, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => { resolve("timeout"); }, remaining);
    });
    const outcome = await Promise.race([
      changed.wait().then(() => "changed"),
      timeout,
    ]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      throw new Error(`Timed out waiting for ${description}.`);
    }
  }
}

export async function createSyntheticFixtureBoundary() {
  const nonce = randomUUID();
  const changed = createChangeSignal();
  const connections = new Map();
  const sockets = new Set();
  let stopping = false;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => { socket.destroy(); });
    let authenticated = false;
    let source = "";
    socket.on("data", (chunk) => {
      if (authenticated) {
        return;
      }
      source += chunk;
      const newline = source.indexOf("\n");
      if (newline === -1) {
        return;
      }
      let registration;
      try {
        registration = JSON.parse(source.slice(0, newline));
      } catch {
        socket.destroy();
        return;
      }
      if (
        registration?.nonce !== nonce ||
        typeof registration.role !== "string" ||
        !FIXTURE_ROLE_PATTERN.test(registration.role) ||
        connections.has(registration.role)
      ) {
        socket.destroy();
        return;
      }
      authenticated = true;
      const record = { closed: false, socket };
      connections.set(registration.role, record);
      socket.once("close", () => {
        record.closed = true;
        changed.notify();
      });
      changed.notify();
      if (stopping) {
        socket.write(`${JSON.stringify({ command: "stop", nonce })}\n`);
      }
    });
    socket.once("close", () => {
      sockets.delete(socket);
      changed.notify();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Synthetic fixture boundary did not bind an IPv4 port.");
  }

  let stopPromise;
  return {
    environment: {
      QGR_FIXTURE_HOST: "127.0.0.1",
      QGR_FIXTURE_NONCE: nonce,
      QGR_FIXTURE_PORT: String(address.port),
    },
    nonce,
    async assertStopped(roles) {
      await waitUntil(
        () => roles.every((role) => connections.get(role)?.closed === true),
        changed,
        TEST_HARNESS_SHUTDOWN_GRACE_MS,
        `owned fixture roles to stop: ${roles.join(", ")}`,
      );
    },
    async stop() {
      stopPromise ??= (async () => {
        stopping = true;
        const stop = `${JSON.stringify({ command: "stop", nonce })}\n`;
        for (const { closed, socket } of connections.values()) {
          if (!closed) {
            socket.write(stop);
          }
        }
        for (const socket of sockets) {
          if (![...connections.values()].some((record) => record.socket === socket)) {
            socket.destroy();
          }
        }
        await waitUntil(
          () => [...connections.values()].every(({ closed }) => closed),
          changed,
          TEST_HARNESS_SHUTDOWN_GRACE_MS,
          "the authenticated synthetic fixture boundary to close",
        );
        await new Promise((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        });
      })();
      return await stopPromise;
    },
    async waitForRoles(roles) {
      await waitUntil(
        () => roles.every((role) => connections.has(role)),
        changed,
        TEST_HARNESS_SHUTDOWN_GRACE_MS,
        `owned fixture roles to register: ${roles.join(", ")}`,
      );
    },
  };
}

function waitForChildClose(command, timeoutMs) {
  if (command.exitCode !== null || command.signalCode !== null) {
    return Promise.resolve(true);
  }
  return Promise.race([
    once(command, "close").then(() => true),
    delay(timeoutMs, false),
  ]);
}

async function terminateRetainedChild(command) {
  if (command.exitCode !== null || command.signalCode !== null) {
    return;
  }
  command.kill("SIGTERM");
  if (await waitForChildClose(command, TEST_HARNESS_SHUTDOWN_GRACE_MS)) {
    return;
  }
  if (command.exitCode === null && command.signalCode === null) {
    command.kill("SIGKILL");
  }
  if (!await waitForChildClose(command, TEST_HARNESS_SHUTDOWN_GRACE_MS)) {
    throw new Error("Retained CLI fixture did not close after forced shutdown.");
  }
}

export function startBoundedCli(cliPath, arguments_, options = {}) {
  const command = spawn(process.execPath, [cliPath, ...arguments_], {
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  command.stderr.setEncoding("utf8");
  command.stdout.setEncoding("utf8");
  command.stderr.on("data", (chunk) => { stderr += chunk; });
  command.stdout.on("data", (chunk) => { stdout += chunk; });

  const completed = new Promise((resolve, reject) => {
    command.once("error", reject);
    command.once("close", (status, signal) => {
      resolve({ signal, status, stderr, stdout });
    });
  });
  let termination;
  const terminate = () => {
    termination ??= (async () => {
      const outcomes = await Promise.allSettled([
        terminateRetainedChild(command),
        options.fixtureBoundary?.stop() ?? Promise.resolve(),
      ]);
      const failures = outcomes
        .filter(({ status }) => status === "rejected")
        .map(({ reason }) => reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Synthetic CLI fixture cleanup failed.");
      }
    })();
    return termination;
  };

  let watchdogExpired = false;
  let rejectWatchdog;
  const watchdogFailure = new Promise((_resolve, reject) => { rejectWatchdog = reject; });
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    void terminate().then(
      () => rejectWatchdog(
        new Error(
          `Test-harness watchdog expired after ${TEST_HARNESS_WATCHDOG_MS}ms; ` +
          "QGR task timeout semantics were not changed.",
        ),
      ),
      (error) => rejectWatchdog(
        new AggregateError(
          [error],
          `Test-harness watchdog expired after ${TEST_HARNESS_WATCHDOG_MS}ms and cleanup failed.`,
        ),
      ),
    );
  }, TEST_HARNESS_WATCHDOG_MS);
  const result = Promise.race([
    completed.then((value) => watchdogExpired ? watchdogFailure : value),
    watchdogFailure,
  ]).finally(() => { clearTimeout(watchdog); });
  return {
    command,
    result,
    async stop() {
      await terminate();
      await completed.catch(() => {});
    },
  };
}

export async function removeFixtureRoot(root) {
  await rm(root, {
    force: true,
    maxRetries: process.platform === "win32" ? 50 : 0,
    recursive: true,
    retryDelay: 100,
  });
}

export async function writeFixtureBoundaryClient(root) {
  await writeFile(join(root, "fixture-boundary-client.cjs"), `const { once } = require("node:events");
const { createConnection } = require("node:net");

exports.connect = async function connect(role, onStop = async () => {}) {
  const host = process.env.QGR_FIXTURE_HOST;
  const nonce = process.env.QGR_FIXTURE_NONCE;
  const port = Number.parseInt(process.env.QGR_FIXTURE_PORT ?? "", 10);
  if (host === undefined || nonce === undefined || !Number.isSafeInteger(port)) {
    return undefined;
  }
  const socket = createConnection({ host, port });
  await Promise.race([
    once(socket, "connect"),
    once(socket, "error").then(([error]) => { throw error; }),
  ]);
  socket.setEncoding("utf8");
  socket.write(JSON.stringify({ nonce, role }) + "\\n");
  let source = "";
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await onStop();
    } finally {
      process.exit(0);
    }
  };
  socket.on("data", (chunk) => {
    source += chunk;
    for (;;) {
      const newline = source.indexOf("\\n");
      if (newline === -1) return;
      const message = JSON.parse(source.slice(0, newline));
      source = source.slice(newline + 1);
      if (message.nonce === nonce && message.command === "stop") void stop();
    }
  });
  socket.once("error", () => { void stop(); });
  socket.once("close", () => { void stop(); });
  return socket;
};
`, "utf8");
}
