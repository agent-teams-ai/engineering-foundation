import assert from "node:assert/strict";

export interface ObservationBudget {
  remainingWaitMs: number;
}
export interface ResponseObservation {
  readonly url: string;
  readonly method: "GET";
  readonly attempt: number;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly finishedAt: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string | null>>;
  readonly authorizationHeaderSent: boolean;
  readonly bytes: number;
  readonly bodyComplete: boolean;
  readonly bodyTruncated: boolean;
  readonly bodyReadError: string | null;
  readonly successful: boolean;
}
export interface WaitObservation {
  readonly url: string;
  readonly attempt: number;
  readonly startedAt: string;
  readonly notBefore: string;
  readonly waitMs: number;
  readonly remainingBudgetMs: number;
  readonly reasons: readonly string[];
}
export interface ObservationRuntime {
  readonly request: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly capture: (body: Buffer, observation: ResponseObservation) => void;
  readonly captureWait: (observation: WaitObservation) => void;
}

const maximumWaitMs = 68 * 60_000;
const responseHeaderNames = [
  "date",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-used",
  "x-ratelimit-resource",
  "retry-after",
  "x-github-request-id",
] as const;

function decimal(value: string, name: string): number {
  assert(/^[0-9]+$/u.test(value), "Malformed provider header: " + name);
  const result = Number(value);
  assert(Number.isSafeInteger(result), "Unsafe provider header: " + name);
  return result;
}

function providerWait(
  url: URL,
  status: number,
  headers: Readonly<Record<string, string | null>>,
  receivedAt: number,
  now: number,
  attempt: number,
): { notBefore: number; reasons: string[] } {
  assert(
    url.origin === "https://api.github.com" && (status === 403 || status === 429),
    "HTTP response does not authorize observation backoff",
  );
  const reasons: string[] = [];
  let notBefore = now + 60_000 * 2 ** (attempt - 1);
  const retryAfter = headers["retry-after"];
  if (retryAfter !== null && retryAfter !== undefined) {
    const milliseconds = decimal(retryAfter, "retry-after") * 1000;
    assert(Number.isSafeInteger(milliseconds + receivedAt), "Unsafe retry-after deadline");
    notBefore = Math.max(notBefore, receivedAt + milliseconds);
    reasons.push("retry-after");
  }
  const remaining = headers["x-ratelimit-remaining"];
  if (remaining !== null && remaining !== undefined) {
    const count = decimal(remaining, "x-ratelimit-remaining");
    if (count === 0) {
      const reset = headers["x-ratelimit-reset"];
      assert(typeof reset === "string", "Exhausted quota requires its reset header");
      const deadline = decimal(reset, "x-ratelimit-reset") * 1000 + 1500;
      assert(Number.isSafeInteger(deadline), "Unsafe quota reset deadline");
      notBefore = Math.max(notBefore, deadline);
      reasons.push("primary-rate-reset");
    }
  }
  assert(reasons.length > 0, "HTTP refusal has no explicit provider backoff signal");
  return { notBefore, reasons };
}

/** Read-only observation retries retain the same request and never invoke managed code. */
export async function observeGet(
  url: URL,
  headers: Readonly<Record<string, string>>,
  label: string,
  maximum: number,
  budget: ObservationBudget,
  runtime: ObservationRuntime,
): Promise<Buffer> {
  assert(url.protocol === "https:" && !url.username && !url.password);
  assert(
    url.origin === "https://registry.npmjs.org" ||
      (url.origin === "https://api.github.com" &&
        url.pathname.startsWith("/repos/agent-teams-ai/")),
  );
  assert(/^[a-z0-9][a-z0-9.-]*$/u.test(label));
  assert(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 8 * 1024 * 1024);
  assert(
    Number.isSafeInteger(budget.remainingWaitMs) &&
      budget.remainingWaitMs >= 0 &&
      budget.remainingWaitMs <= maximumWaitMs,
  );
  const address = new URL(url.href);
  const requestHeaders = Object.freeze({ ...headers });
  const authorizationHeaderSent = Object.keys(requestHeaders).some(
    (name) => name.toLowerCase() === "authorization",
  );
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const observedAt = runtime.now();
    const response = await runtime.request(address.href, {
      method: "GET",
      headers: requestHeaders,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    const receivedAt = runtime.now();
    const responseHeaders: Record<string, string | null> = {};
    for (const name of responseHeaderNames) {
      responseHeaders[name] = response.headers.get(name);
    }
    const limit = response.ok ? maximum : 64 * 1024;
    const chunks: Uint8Array[] = [];
    let count = 0;
    let bodyTruncated = false;
    let bodyReadError: string | null = null;
    if (response.body === null) {
      bodyReadError = "Response body is missing";
    } else {
      try {
        for await (const chunk of response.body) {
          const available = limit - count;
          if (chunk.byteLength > available) {
            chunks.push(chunk.subarray(0, available));
            count += available;
            bodyTruncated = true;
            break;
          }
          chunks.push(chunk);
          count += chunk.byteLength;
        }
      } catch (error) {
        bodyReadError = error instanceof Error ? error.message : String(error);
      }
    }
    const body = Buffer.concat(chunks);
    const bodyComplete = !bodyTruncated && bodyReadError === null;
    const successful = response.ok && bodyComplete;
    runtime.capture(body, {
      url: address.href,
      method: "GET",
      attempt,
      observedAt: new Date(observedAt).toISOString(),
      receivedAt: new Date(receivedAt).toISOString(),
      finishedAt: new Date(runtime.now()).toISOString(),
      status: response.status,
      headers: responseHeaders,
      authorizationHeaderSent,
      bytes: body.length,
      bodyComplete,
      bodyTruncated,
      bodyReadError,
      successful,
    });
    assert(bodyComplete, "Incomplete bounded observation: " + label);
    if (successful) {
      return body;
    }
    assert(attempt < 4, "Observation attempts exhausted: " + label);
    const now = runtime.now();
    const { notBefore, reasons } = providerWait(
      address,
      response.status,
      responseHeaders,
      receivedAt,
      now,
      attempt,
    );
    const waitMs = notBefore - now;
    assert(
      Number.isSafeInteger(waitMs) && waitMs <= budget.remainingWaitMs,
      "Provider backoff exceeds the shared bootstrap wait budget: " + label,
    );
    budget.remainingWaitMs -= waitMs;
    runtime.captureWait({
      url: address.href,
      attempt,
      startedAt: new Date(now).toISOString(),
      notBefore: new Date(notBefore).toISOString(),
      waitMs,
      remainingBudgetMs: budget.remainingWaitMs,
      reasons,
    });
    for (let remaining = waitMs; remaining > 0; ) {
      const slice = Math.min(60_000, remaining);
      await runtime.wait(slice);
      remaining -= slice;
    }
    assert(runtime.now() >= notBefore, "Provider backoff deadline has not elapsed");
  }
  throw new Error("Observation attempts exhausted: " + label);
}
