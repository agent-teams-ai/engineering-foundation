import { rm } from "node:fs/promises";

import {
  spawnNodeManagedProcess,
  terminateNodeManagedProcess,
  terminatePosixProcessGroup,
} from "../../packages/engineering-foundation/dist/process-execution/node-process-runner.js";

const TEST_HARNESS_WATCHDOG_MS = 120_000;
const TEST_HARNESS_SHUTDOWN_GRACE_MS = process.platform === "win32" ? 15_000 : 5_000;
const FIXTURE_ENVIRONMENT_PATTERN = /^QGR_FIXTURE_/iu;

function normalizeError(error, message) {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function defaultDeadline(milliseconds) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  return { cancel: () => { clearTimeout(timer); }, promise };
}

function startAction(action) {
  try {
    return Promise.resolve(action());
  } catch (error) {
    return Promise.reject(error);
  }
}

async function settleWithin(promise, label, milliseconds, createDeadline) {
  const actionOutcome = promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ reason, status: "rejected" }),
  );
  const deadline = createDeadline(milliseconds, label);
  const deadlineOutcome = deadline.promise.then(
    () => ({ status: "timed-out" }),
    (reason) => ({ reason, status: "deadline-failed" }),
  );
  try {
    return await Promise.race([actionOutcome, deadlineOutcome]);
  } finally {
    deadline.cancel();
  }
}

function outcomeFailure(outcome, label, milliseconds) {
  if (outcome.status === "fulfilled") {
    return;
  }
  if (outcome.status === "timed-out") {
    return new Error(`${label} exceeded its ${milliseconds}ms cleanup deadline.`);
  }
  if (outcome.status === "deadline-failed") {
    return new Error(`${label} deadline failed.`, { cause: outcome.reason });
  }
  return new Error(`${label} failed.`, { cause: outcome.reason });
}

async function boundedAction(action, label, milliseconds, createDeadline) {
  const outcome = await settleWithin(startAction(action), label, milliseconds, createDeadline);
  return outcomeFailure(outcome, label, milliseconds);
}

async function runCleanupStage({
  actionDeadlineMs,
  actions,
  createDeadline,
  failures,
  label,
  stageDeadlineMs,
}) {
  const actionsPromise = Promise.all(actions.map(({ action, actionLabel }) => (
    boundedAction(action, actionLabel, actionDeadlineMs, createDeadline)
  )));
  const stageOutcome = await settleWithin(
    actionsPromise,
    `${label} stage`,
    stageDeadlineMs,
    createDeadline,
  );
  const stageFailure = outcomeFailure(stageOutcome, `${label} stage`, stageDeadlineMs);
  if (stageFailure !== undefined) {
    failures.push(stageFailure);
    return;
  }
  failures.push(...stageOutcome.value.filter((failure) => failure !== undefined));
}

function sanitizedChildEnvironment(source, fixtureBoundary, fixtureRole) {
  const environment = {};
  for (const [key, value] of Object.entries(source)) {
    if (!FIXTURE_ENVIRONMENT_PATTERN.test(key) && value !== undefined) {
      environment[key] = value;
    }
  }
  if (fixtureRole !== undefined) {
    if (typeof fixtureBoundary?.environmentFor !== "function") {
      throw new TypeError("A fixture role requires a credential-issuing fixture boundary.");
    }
    Object.assign(environment, fixtureBoundary.environmentFor(fixtureRole));
  }
  return environment;
}

async function waitForClose(completed, label, milliseconds, createDeadline) {
  const outcome = await settleWithin(completed, label, milliseconds, createDeadline);
  if (outcome.status === "timed-out") {
    return false;
  }
  const failure = outcomeFailure(outcome, label, milliseconds);
  if (failure !== undefined) {
    throw failure;
  }
  return true;
}

async function terminateDirectChild(command, completed, shutdownGraceMs, createDeadline) {
  if (command.exitCode === null && command.signalCode === null) {
    command.kill("SIGTERM");
  }
  if (await waitForClose(
    completed,
    "Retained CLI close after SIGTERM",
    shutdownGraceMs,
    createDeadline,
  )) {
    return;
  }
  if (command.exitCode === null && command.signalCode === null) {
    command.kill("SIGKILL");
  }
  if (!await waitForClose(
    completed,
    "Retained CLI close after SIGKILL",
    shutdownGraceMs,
    createDeadline,
  )) {
    throw new Error("Retained CLI fixture did not close after forced shutdown.");
  }
}

async function terminateRetainedChild(
  command,
  completed,
  shutdownGraceMs,
  createDeadline,
  terminateTree,
  managedProcessGroups,
) {
  const terminations = [];
  if (terminateTree === undefined) {
    terminations.push(terminateDirectChild(
      command,
      completed,
      shutdownGraceMs,
      createDeadline,
    ));
  } else {
    terminations.push(terminateTree(command));
  }
  if (process.platform !== "win32") {
    terminations.push(...[...managedProcessGroups].map((processGroupId) => (
      terminatePosixProcessGroup(processGroupId)
    )));
  }
  const outcomes = await Promise.allSettled(terminations);
  const failures = outcomes
    .filter(({ status }) => status === "rejected")
    .map(({ reason }) => normalizeError(reason, "Managed process group cleanup failed."));
  if (failures.length > 0) {
    throw new AggregateError(failures, "Managed process containment cleanup failed.");
  }
  if (!await waitForClose(
    completed,
    "Retained CLI close after tree termination",
    shutdownGraceMs,
    createDeadline,
  )) {
    throw new Error("Retained CLI process tree terminated without closing its streams.");
  }
}

function collectCleanupFailures(outcomes, cleanupFailures) {
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      cleanupFailures.push(normalizeError(outcome.reason, "Watchdog cleanup failed."));
    }
  }
  return cleanupFailures;
}

function appendUniqueFailures(destination, candidates) {
  for (const candidate of candidates) {
    if (!destination.includes(candidate)) {
      destination.push(candidate);
    }
  }
}

export async function awaitQgrSetupBeforeTransfer(execution, validate = () => {}) {
  try {
    const result = await execution.result;
    await validate(result);
    return result;
  } catch (error) {
    const cleanupFailures = [];
    if (error?.cleanup !== undefined) {
      try {
        appendUniqueFailures(cleanupFailures, await error.cleanup);
      } catch (cleanupError) {
        appendUniqueFailures(cleanupFailures, [cleanupError]);
      }
    }
    try {
      await execution.stop();
    } catch (cleanupError) {
      appendUniqueFailures(cleanupFailures, [cleanupError]);
    }
    if (error instanceof Error && Object.isExtensible(error)) {
      Object.defineProperty(error, "setupCleanupFailures", {
        enumerable: true,
        value: Object.freeze([...cleanupFailures]),
      });
    }
    throw error;
  }
}

export function createControlledQgrCancellationSource() {
  let listener;
  return {
    cancel(cancellation = "interrupt") {
      if (listener === undefined) {
        throw new Error("Controlled QGR cancellation was requested without an active subscriber.");
      }
      listener(cancellation);
    },
    subscribe(onCancellation) {
      if (listener !== undefined) {
        throw new Error("Controlled QGR cancellation accepts only one active subscriber.");
      }
      listener = onCancellation;
      return () => { listener = undefined; };
    },
  };
}

export function startCapturedQgrCommand(start) {
  const previousExitCode = process.exitCode;
  const previousWrite = process.stdout.write;
  let stdout = "";
  process.exitCode = undefined;
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  const result = Promise.resolve()
    .then(start)
    .then(() => ({ exitCode: process.exitCode, stdout }))
    .finally(() => {
      process.stdout.write = previousWrite;
      process.exitCode = previousExitCode;
    });
  return { result };
}

export function startBoundedCli(cliPath, arguments_, options = {}) {
  const shutdownGraceMs = options.shutdownGraceMs ?? TEST_HARNESS_SHUTDOWN_GRACE_MS;
  const watchdogMs = options.watchdogMs ?? TEST_HARNESS_WATCHDOG_MS;
  const createDeadline = options.createDeadline ?? defaultDeadline;
  const spawnChild = options.spawnChild ?? ((command, args, spawnOptions) => (
    spawnNodeManagedProcess({
      command,
      args,
      cwd: spawnOptions.cwd ?? process.cwd(),
      environment: spawnOptions.env,
    })
  ));
  const terminateTree = options.terminateTree ?? (
    options.spawnChild === undefined ? terminateNodeManagedProcess : undefined
  );
  const managedProcessGroups = new Set();
  const command = spawnChild(process.execPath, [cliPath, ...arguments_], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: sanitizedChildEnvironment(
      options.env ?? process.env,
      options.fixtureBoundary,
      options.fixtureRole,
    ),
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
  let watchdog;
  let stopPromise;
  const stop = () => {
    stopPromise ??= (async () => {
      clearTimeout(watchdog);
      const failures = [];
      try {
        await terminateRetainedChild(
          command,
          completed,
          shutdownGraceMs,
          createDeadline,
          terminateTree,
          managedProcessGroups,
        );
      } catch (error) {
        failures.push(error);
      }
      const finalClose = await settleWithin(
        completed,
        "Retained CLI final close",
        shutdownGraceMs,
        createDeadline,
      );
      const finalFailure = outcomeFailure(
        finalClose,
        "Retained CLI final close",
        shutdownGraceMs,
      );
      if (finalFailure !== undefined) {
        failures.push(finalFailure);
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
  const armWatchdog = () => {
    if (watchdog !== undefined || stopPromise !== undefined) {
      return;
    }
    watchdog = setTimeout(() => {
      watchdogExpired = true;
      const cleanupFailures = [];
      const cleanupActions = [
        startAction(stop),
        startAction(() => options.fixtureBoundary?.stop()),
      ];
      const cleanup = Promise.allSettled(cleanupActions)
        .then((outcomes) => collectCleanupFailures(outcomes, cleanupFailures));
      const boundedCleanup = settleWithin(
        cleanup,
        "Watchdog containment cleanup",
        options.cleanupDeadlineMs ?? shutdownGraceMs * 3,
        createDeadline,
      ).then((outcome) => {
        const failure = outcomeFailure(
          outcome,
          "Watchdog containment cleanup",
          options.cleanupDeadlineMs ?? shutdownGraceMs * 3,
        );
        if (failure !== undefined) {
          cleanupFailures.push(failure);
        }
        return cleanupFailures;
      });
      const error = new Error(
        `Test-harness watchdog expired after ${watchdogMs}ms; ` +
        "QGR task timeout semantics were not changed.",
      );
      Object.defineProperties(error, {
        cleanup: { enumerable: false, value: boundedCleanup },
        cleanupFailures: { enumerable: true, value: cleanupFailures },
      });
      rejectWatchdog(error);
    }, watchdogMs);
  };
  const result = Promise.race([
    completed.then((value) => watchdogExpired ? watchdogFailure : value),
    watchdogFailure,
  ]).finally(() => { clearTimeout(watchdog); });
  if (options.deferWatchdogUntilReady !== true) {
    armWatchdog();
  }
  return {
    armWatchdog,
    command,
    manageProcessGroup(processGroupId) {
      if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
        throw new TypeError("A managed process group ID must be a positive safe integer.");
      }
      if (process.platform !== "win32" && processGroupId !== command.pid) {
        managedProcessGroups.add(processGroupId);
      }
    },
    result,
    stop,
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

export async function cleanupSyntheticFixture({
  actionDeadlineMs = TEST_HARNESS_SHUTDOWN_GRACE_MS * 3,
  boundaries = [],
  createDeadline = defaultDeadline,
  executions = [],
  remove = removeFixtureRoot,
  roots = [],
  stageDeadlineMs = actionDeadlineMs * 2,
}) {
  const failures = [];
  await runCleanupStage({
    actionDeadlineMs,
    actions: [
      ...executions.map((execution, index) => ({
        action: () => execution?.stop(),
        actionLabel: `CLI child cleanup ${index + 1}`,
      })),
      ...boundaries.map((boundary, index) => ({
        action: () => boundary?.stop(),
        actionLabel: `Fixture boundary cleanup ${index + 1}`,
      })),
    ],
    createDeadline,
    failures,
    label: "Owned process cleanup",
    stageDeadlineMs,
  });
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Synthetic QGR fixture cleanup stopped before fixture deletion because process containment failed.",
    );
  }
  await runCleanupStage({
    actionDeadlineMs,
    actions: roots.map((root, index) => ({
      action: () => remove(root),
      actionLabel: `Fixture root cleanup ${index + 1}`,
    })),
    createDeadline,
    failures,
    label: "Fixture root cleanup",
    stageDeadlineMs,
  });
  if (failures.length > 0) {
    throw new AggregateError(failures, "Synthetic QGR fixture cleanup failed.");
  }
}
