// Node 24.21 emits one completion for each test/suite and its outer file.
// Result events repeat those durations; recording only completions avoids
// double counting without keeping a second test identity inventory.
const active = (value) => value === true || typeof value === "string";

export function testTimingRecord(event) {
  if (event.type !== "test:complete") { return null; }
  const data = event.data;
  const durationMs = data?.details?.duration_ms;
  const file = data?.entryFile ?? data?.file;
  if (typeof file !== "string" || typeof data.name !== "string" ||
    !Number.isFinite(durationMs) || durationMs < 0) { return null; }
  return {
    file, testId: data.testId, parentId: data.parentId, name: data.name,
    kind: data.entryFile === undefined ? "file" : data.details.type,
    outcome: active(data.skip) ? "skip" : active(data.todo) ? "todo" :
      active(data.expectFailure) ? "expected-failure" : data.details.passed ? "pass" : "fail",
    durationMs,
  };
}

export function attachTestTiming(stream, sink) {
  try {
    // Named events do not put the stream into flowing mode. The mandatory
    // verifier remains its only consumer and owns the execution verdict.
    stream.on("test:complete", (data) => {
      try {
        const record = testTimingRecord({ type: "test:complete", data });
        if (record !== null) { sink(record); }
      } catch { /* Observation must never affect verification. */ }
    });
  } catch { /* An unavailable observer does not change the test verdict. */ }
}

export default async function* timingReporter(source) {
  try {
    for await (const event of source) {
      try {
        const record = testTimingRecord(event);
        if (record !== null && process.send !== undefined) {
          await new Promise((resolve) => {
            try { process.send({ type: "foundation:test-timing", record }, () => resolve()); }
            catch { resolve(); }
          });
        }
      } catch { /* Timing is advisory, including a closed IPC sink. */ }
    }
  } catch { /* Keep reporter errors separate from the native test verdict. */ }
  yield "";
  // No reporter bytes: TAP retains stdout. The parent writes timing records
  // after the child verdict, so a destination IO failure cannot fail Node.
}
