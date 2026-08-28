import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { watch } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";

const TEST_HARNESS_WATCHDOG_MS = 120_000;
const TEST_HARNESS_READINESS_MS = 60_000;
const TEST_HARNESS_POLL_MS = 25;
const TEST_HARNESS_SHUTDOWN_GRACE_MS = process.platform === "win32" ? 15_000 : 5_000;
const PRE_AUTHENTICATION_DWELL_MS = 2_000;
const REGISTRATION_BYTE_LIMIT = 4_096;
const FIXTURE_ROLE_PATTERN = /^[a-z][a-z0-9-]*$/u;
const FIXTURE_ENVIRONMENT_PATTERN = /^QGR_FIXTURE_/iu;
const NOOP = () => {};

function missingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeError(error, message) {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

export function observeFixtureEffect({
  pollIntervalMs = TEST_HARNESS_POLL_MS,
  read,
  subscribe,
}) {
  let closed = false;
  let queued = true;
  let reading = false;
  let pollTimer;
  let unsubscribe = NOOP;
  let rejectEffect;
  let resolveEffect;
  const result = new Promise((resolve, reject) => {
    rejectEffect = reject;
    resolveEffect = resolve;
  });

  const cancelPoll = () => {
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };
  const close = () => {
    if (!closed) {
      closed = true;
      cancelPoll();
      unsubscribe();
    }
  };
  const fail = (error) => {
    if (!closed) {
      close();
      rejectEffect(error);
    }
  };
  const schedulePoll = () => {
    if (!closed && pollTimer === undefined) {
      pollTimer = setTimeout(() => {
        pollTimer = undefined;
        notify();
      }, pollIntervalMs);
    }
  };
  const drain = async () => {
    if (closed || reading) {
      return;
    }
    reading = true;
    try {
      for (;;) {
        if (closed || !queued) {
          break;
        }
        queued = false;
        try {
          const effect = await read();
          close();
          resolveEffect(effect);
        } catch (error) {
          if (missingFile(error)) {
            schedulePoll();
          } else {
            fail(error);
          }
        }
      }
    } finally {
      reading = false;
    }
  };
  function notify() {
    if (closed) {
      return;
    }
    cancelPoll();
    queued = true;
    void drain();
  }

  unsubscribe = subscribe(notify, fail);
  void drain();
  return { close, result };
}

export async function waitForFixtureEffect(
  path,
  execution,
  parse = (source) => source,
  { readinessDeadlineMs = TEST_HARNESS_READINESS_MS } = {},
) {
  const observation = observeFixtureEffect({
    read: async () => parse(await readFile(path, "utf8")),
    subscribe(notify) {
      let watcher;
      try {
        watcher = watch(dirname(path), { persistent: false }, notify);
        watcher.once("error", () => { watcher.close(); });
      } catch {
        return NOOP;
      }
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
  let deadlineTimer;
  const deadline = new Promise((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(new Error(`Fixture readiness deadline expired after ${readinessDeadlineMs}ms.`));
    }, readinessDeadlineMs);
  });
  try {
    return await Promise.race([observation.result, commandClosed, deadline]);
  } finally {
    clearTimeout(deadlineTimer);
    observation.close();
  }
}

export function createGenerationAwareChangeSignal() {
  let generation = 0;
  let waiters = [];
  return {
    generation() {
      return generation;
    },
    notify() {
      generation += 1;
      const current = waiters;
      waiters = [];
      for (const { resolve } of current) {
        resolve(generation);
      }
    },
    wait(observedGeneration) {
      if (observedGeneration !== generation) {
        return Promise.resolve(generation);
      }
      return new Promise((resolve) => { waiters.push({ observedGeneration, resolve }); });
    },
  };
}

async function waitUntil(predicate, changed, timeoutMs, description, onTimeout = NOOP) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observedGeneration = changed.generation();
    if (predicate()) {
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      onTimeout();
      throw new Error(`Timed out waiting for ${description}.`);
    }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => { resolve("timeout"); }, remaining);
    });
    const outcome = await Promise.race([
      changed.wait(observedGeneration).then(() => "changed"),
      timeout,
    ]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      onTimeout();
      throw new Error(`Timed out waiting for ${description}.`);
    }
  }
}

function validateExpectedRoles(expectedRoles) {
  if (
    !Array.isArray(expectedRoles) ||
    expectedRoles.length === 0 ||
    expectedRoles.some((role) => typeof role !== "string" || !FIXTURE_ROLE_PATTERN.test(role)) ||
    new Set(expectedRoles).size !== expectedRoles.length
  ) {
    throw new TypeError("Synthetic fixture boundary expectedRoles must be unique portable role IDs.");
  }
  return new Set(expectedRoles);
}

function exactConsumptionFailures(declaredRoles, registrationCounts) {
  const issues = [];
  for (const role of declaredRoles) {
    const count = registrationCounts.get(role) ?? 0;
    if (count !== 1) {
      issues.push(new Error(`Expected exactly one registration/invocation for ${role}; observed ${count}.`));
    }
  }
  for (const role of registrationCounts.keys()) {
    if (!declaredRoles.has(role)) {
      issues.push(new Error(`Observed unexpected fixture role ${role}.`));
    }
  }
  return issues;
}

function inactiveRoleFailures(declaredRoles, connections) {
  return [...declaredRoles]
    .filter((role) => connections.get(role)?.closed !== false)
    .map((role) => new Error(`Expected fixture role ${role} to be active concurrently.`));
}

export async function createSyntheticFixtureBoundary({
  expectedRoles,
  maximumRegistrationBytes = REGISTRATION_BYTE_LIMIT,
  preAuthenticationDwellMs = PRE_AUTHENTICATION_DWELL_MS,
  shutdownGraceMs = TEST_HARNESS_SHUTDOWN_GRACE_MS,
} = {}) {
  const declaredRoles = validateExpectedRoles(expectedRoles);
  const nonce = randomUUID();
  const changed = createGenerationAwareChangeSignal();
  const connections = new Map();
  const failures = [];
  const registrationCounts = new Map();
  const sockets = new Map();
  let serverClosed = false;
  let serverCloseError;
  let stopping = false;

  const recordFailure = (message, cause) => {
    failures.push(cause === undefined ? new Error(message) : new Error(message, { cause }));
    changed.notify();
  };
  const destroyRetainedSockets = () => {
    for (const socket of sockets.keys()) {
      socket.destroy();
    }
  };
  const assertHealthy = () => {
    if (failures.length > 0) {
      throw new AggregateError([...failures], "Synthetic fixture boundary rejected invalid traffic.");
    }
  };
  const server = createServer((socket) => {
    if (stopping) {
      recordFailure("Synthetic fixture boundary accepted a new socket after stopping began.");
      socket.destroy();
      return;
    }
    const state = {
      authenticated: false,
      boundaryDestroyed: false,
      failureRecorded: false,
      source: Buffer.alloc(0),
      timer: undefined,
    };
    sockets.set(socket, state);
    const rejectSocket = (message, cause) => {
      if (!state.failureRecorded) {
        state.failureRecorded = true;
        recordFailure(message, cause);
      }
      socket.destroy();
    };
    socket.on("error", (error) => {
      if (!state.boundaryDestroyed) {
        rejectSocket("Synthetic fixture boundary socket failed.", error);
      }
    });
    state.timer = setTimeout(() => {
      if (!state.authenticated && !socket.destroyed) {
        rejectSocket(
          `Synthetic fixture registration exceeded ${preAuthenticationDwellMs}ms.`,
        );
      }
    }, preAuthenticationDwellMs);
    state.timer.unref?.();
    socket.on("data", (chunk) => {
      if (state.authenticated) {
        if (chunk.length > 0) {
          rejectSocket("Authenticated fixture socket sent unexpected data.");
        }
        return;
      }
      if (state.source.length + chunk.length > maximumRegistrationBytes) {
        rejectSocket(`Synthetic fixture registration exceeded ${maximumRegistrationBytes} bytes.`);
        return;
      }
      state.source = Buffer.concat([state.source, chunk]);
      const newline = state.source.indexOf(0x0a);
      if (newline === -1) {
        return;
      }
      if (newline !== state.source.length - 1) {
        rejectSocket("Synthetic fixture registration contained trailing data.");
        return;
      }
      let registration;
      try {
        registration = JSON.parse(state.source.subarray(0, newline).toString("utf8"));
      } catch (error) {
        rejectSocket("Synthetic fixture registration was not valid JSON.", error);
        return;
      }
      const role = registration?.role;
      if (registration?.nonce !== nonce) {
        rejectSocket("Synthetic fixture registration used an invalid nonce.");
        return;
      }
      if (typeof role !== "string" || !FIXTURE_ROLE_PATTERN.test(role)) {
        rejectSocket("Synthetic fixture registration used an invalid role.");
        return;
      }
      registrationCounts.set(role, (registrationCounts.get(role) ?? 0) + 1);
      if (!declaredRoles.has(role)) {
        rejectSocket(`Synthetic fixture registration used unexpected role ${role}.`);
        return;
      }
      if (connections.has(role)) {
        rejectSocket(`Synthetic fixture role ${role} registered more than once.`);
        return;
      }
      state.authenticated = true;
      clearTimeout(state.timer);
      const record = { closed: false, socket };
      connections.set(role, record);
      socket.once("close", () => {
        record.closed = true;
        changed.notify();
      });
      changed.notify();
      socket.write(`${JSON.stringify({ command: "registered", nonce, role })}\n`);
    });
    socket.once("close", () => {
      clearTimeout(state.timer);
      sockets.delete(socket);
      if (!state.authenticated && !state.boundaryDestroyed && !state.failureRecorded) {
        state.failureRecorded = true;
        recordFailure("Synthetic fixture socket closed before authentication.");
      }
      changed.notify();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Synthetic fixture boundary did not bind an IPv4 port.");
  }

  let stopPromise;
  const environment = Object.freeze({
    QGR_FIXTURE_HOST: "127.0.0.1",
    QGR_FIXTURE_NONCE: nonce,
    QGR_FIXTURE_PORT: String(address.port),
  });
  return {
    environment,
    nonce,
    async assertActive() {
      assertHealthy();
      const issues = [
        ...exactConsumptionFailures(declaredRoles, registrationCounts),
        ...inactiveRoleFailures(declaredRoles, connections),
      ];
      if (issues.length > 0) {
        throw new AggregateError(issues, "Synthetic fixture concurrent-activity assertion failed.");
      }
    },
    async assertExactConsumption() {
      assertHealthy();
      const issues = exactConsumptionFailures(declaredRoles, registrationCounts);
      if (issues.length > 0) {
        throw new AggregateError(issues, "Synthetic fixture exact-consumption assertion failed.");
      }
    },
    async assertStopped() {
      await waitUntil(
        () => {
          assertHealthy();
          return [...declaredRoles].every((role) => connections.get(role)?.closed === true);
        },
        changed,
        shutdownGraceMs,
        `owned fixture roles to stop: ${[...declaredRoles].join(", ")}`,
      );
      await this.assertExactConsumption();
    },
    async stop() {
      stopPromise ??= (async () => {
        stopping = true;
        server.close((error) => {
          serverCloseError = error;
          serverClosed = true;
          changed.notify();
        });
        const authenticatedSockets = new Set(
          [...connections.values()].map(({ socket }) => socket),
        );
        for (const [socket, state] of sockets) {
          if (!state.authenticated || !authenticatedSockets.has(socket)) {
            state.boundaryDestroyed = true;
            socket.destroy();
          }
        }
        const stop = `${JSON.stringify({ command: "stop", nonce })}\n`;
        for (const { closed, socket } of connections.values()) {
          if (!closed) {
            socket.write(stop);
          }
        }
        const cleanupFailures = [];
        try {
          await waitUntil(
            () => serverClosed && [...connections.values()].every(({ closed }) => closed),
            changed,
            shutdownGraceMs,
            "the authenticated sockets and synthetic fixture server to close",
            destroyRetainedSockets,
          );
        } catch (error) {
          cleanupFailures.push(error);
        } finally {
          if (cleanupFailures.length > 0) {
            destroyRetainedSockets();
          }
        }
        if (serverCloseError !== undefined) {
          cleanupFailures.push(serverCloseError);
        }
        cleanupFailures.push(
          ...failures,
          ...exactConsumptionFailures(declaredRoles, registrationCounts),
        );
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            cleanupFailures,
            `Synthetic fixture boundary shutdown failed: ${cleanupFailures
              .map((error) => String(error?.message ?? error))
              .join("; ")}`,
          );
        }
      })();
      return await stopPromise;
    },
    async waitForRoles() {
      await waitUntil(
        () => {
          assertHealthy();
          return [...declaredRoles].every((role) => connections.has(role));
        },
        changed,
        shutdownGraceMs,
        `owned fixture roles to register: ${[...declaredRoles].join(", ")}`,
      );
      await this.assertExactConsumption();
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

async function terminateRetainedChild(command, shutdownGraceMs) {
  if (command.exitCode !== null || command.signalCode !== null) {
    return;
  }
  command.kill("SIGTERM");
  if (await waitForChildClose(command, shutdownGraceMs)) {
    return;
  }
  if (command.exitCode === null && command.signalCode === null) {
    command.kill("SIGKILL");
  }
  if (!await waitForChildClose(command, shutdownGraceMs)) {
    throw new Error("Retained CLI fixture did not close after forced shutdown.");
  }
}

function sanitizedChildEnvironment(source, fixtureBoundary) {
  const environment = {};
  for (const [key, value] of Object.entries(source)) {
    if (!FIXTURE_ENVIRONMENT_PATTERN.test(key) && value !== undefined) {
      environment[key] = value;
    }
  }
  if (fixtureBoundary?.environment !== undefined) {
    Object.assign(environment, fixtureBoundary.environment);
  }
  return environment;
}

export function startBoundedCli(cliPath, arguments_, options = {}) {
  const shutdownGraceMs = options.shutdownGraceMs ?? TEST_HARNESS_SHUTDOWN_GRACE_MS;
  const watchdogMs = options.watchdogMs ?? TEST_HARNESS_WATCHDOG_MS;
  const command = spawn(process.execPath, [cliPath, ...arguments_], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: sanitizedChildEnvironment(options.env ?? process.env, options.fixtureBoundary),
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
  let stopPromise;
  const stop = () => {
    stopPromise ??= (async () => {
      const failures = [];
      try {
        try {
          await terminateRetainedChild(command, shutdownGraceMs);
        } catch (error) {
          failures.push(error);
        }
      } finally {
        try {
          await completed;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Synthetic CLI child cleanup failed.");
      }
    })();
    return stopPromise;
  };

  let watchdogExpired = false;
  let rejectWatchdog;
  const watchdogFailure = new Promise((_resolve, reject) => { rejectWatchdog = reject; });
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    const cleanupFailures = [];
    let settleCleanup;
    const cleanup = new Promise((resolve) => {
      settleCleanup = resolve;
    });
    const error = new Error(
      `Test-harness watchdog expired after ${watchdogMs}ms; ` +
      "QGR task timeout semantics were not changed.",
    );
    Object.defineProperties(error, {
      cleanup: { enumerable: false, value: cleanup },
      cleanupFailures: { enumerable: true, value: cleanupFailures },
    });
    rejectWatchdog(error);
    setImmediate(() => {
      void Promise.allSettled([
        Promise.resolve().then(() => stop()),
        Promise.resolve().then(() => options.fixtureBoundary?.stop()),
      ]).then((outcomes) => {
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            cleanupFailures.push(normalizeError(outcome.reason, "Watchdog cleanup failed."));
          }
        }
        settleCleanup(cleanupFailures);
        return cleanupFailures;
      });
    });
  }, watchdogMs);
  const result = Promise.race([
    completed.then((value) => watchdogExpired ? watchdogFailure : value),
    watchdogFailure,
  ]).finally(() => { clearTimeout(watchdog); });
  return { command, result, stop };
}

export async function removeFixtureRoot(root) {
  await rm(root, {
    force: true,
    maxRetries: process.platform === "win32" ? 50 : 0,
    recursive: true,
    retryDelay: 100,
  });
}

export async function cleanupSyntheticFixture({
  boundaries = [],
  executions = [],
  remove = removeFixtureRoot,
  roots = [],
}) {
  const failures = [];
  const runStage = async (label, actions) => {
    const outcomes = await Promise.allSettled(
      actions.map((action) => Promise.resolve().then(action)),
    );
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "rejected") {
        failures.push(new Error(`${label} ${index + 1} failed.`, { cause: outcome.reason }));
      }
    }
  };
  await runStage("CLI child cleanup", executions.map((execution) => () => execution?.stop()));
  await runStage("Fixture boundary cleanup", boundaries.map((boundary) => () => boundary?.stop()));
  await runStage("Fixture root cleanup", roots.map((root) => () => remove(root)));
  if (failures.length > 0) {
    throw new AggregateError(failures, "Synthetic QGR fixture cleanup failed.");
  }
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
  socket.setEncoding("utf8");
  await Promise.race([
    once(socket, "connect"),
    once(socket, "error").then(([error]) => { throw error; }),
  ]);
  socket.write(JSON.stringify({ nonce, role }) + "\\n");
  let authenticated = false;
  let source = "";
  let stopping = false;
  let rejectRegistration;
  let resolveRegistration;
  const registration = new Promise((resolve, reject) => {
    rejectRegistration = reject;
    resolveRegistration = resolve;
  });
  const fail = (error) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!authenticated) {
      rejectRegistration(failure);
      return;
    }
    process.stderr.write(String(failure.stack ?? failure) + "\\n");
    socket.destroy();
    process.exit(1);
  };
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
      let message;
      try {
        message = JSON.parse(source.slice(0, newline));
      } catch (error) {
        fail(error);
        return;
      }
      source = source.slice(newline + 1);
      if (!authenticated) {
        if (
          message.nonce !== nonce ||
          message.command !== "registered" ||
          message.role !== role
        ) {
          fail(new Error("Fixture boundary returned an invalid registration ACK."));
          return;
        }
        authenticated = true;
        resolveRegistration();
      } else if (message.nonce === nonce && message.command === "stop") {
        void stop();
      } else {
        fail(new Error("Fixture boundary returned an unexpected authenticated message."));
        return;
      }
    }
  });
  socket.once("error", (error) => { fail(error); });
  socket.once("close", () => {
    if (!stopping) fail(new Error(
      authenticated
        ? "Authenticated fixture boundary closed without an owned stop command."
        : "Fixture boundary closed before registration ACK.",
    ));
  });
  await registration;
  return socket;
};
`, "utf8");
}
