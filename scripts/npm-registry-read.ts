export async function readRegistryBytes(
  url: string,
  fetchImplementation: typeof fetch = fetch,
  milliseconds = 10_000,
  maximumBytes = 8 * 1024 * 1024,
): Promise<{ status: number; bytes: Buffer }> {
  const controller = new AbortController();
  let phase = "headers";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        Object.assign(new Error("npm registry observation exceeded its deadline."), {
          code: "REGISTRY_READ_TIMEOUT",
          phase,
        }),
      );
    }, milliseconds);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await fetchImplementation(url, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
        phase = "body";
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (reader === undefined) {
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > maximumBytes) {
            throw Object.assign(new Error("npm registry body exceeds its bound."), {
              code: "REGISTRY_BODY_TOO_LARGE",
              phase,
            });
          }
          return { status: response.status, bytes };
        }
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            size += chunk.value.length;
            if (size > maximumBytes) {
              throw Object.assign(new Error("npm registry body exceeds its bound."), {
                code: "REGISTRY_BODY_TOO_LARGE",
                phase,
              });
            }
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
        return { status: response.status, bytes: Buffer.concat(chunks) };
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const safeCodes = new Set([
  "ABORT_ERR",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "E404",
  "ETARGET",
  "ENEEDAUTH",
  "E403",
  "E401",
  "EINTEGRITY",
  "EBADENGINE",
  "EACCES",
  "ENOENT",
  "REGISTRY_READ_TIMEOUT",
  "REGISTRY_BODY_TOO_LARGE",
]);
function errorRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
export function observationFailure(
  error: unknown,
  phase: "availability" | "install" | "audit" | "audit-json",
) {
  const value = errorRecord(error);
  const nested = errorRecord(value.cause);
  const npmCode =
    typeof value.stderr === "string"
      ? /npm (?:error|ERR!) code (E[A-Z0-9_]+)/u.exec(value.stderr)?.[1]
      : undefined;
  const code = [npmCode, value.code, nested.code].find(
    (candidate): candidate is string => typeof candidate === "string" && safeCodes.has(candidate),
  );
  return {
    phase,
    ...(value.phase === "headers" || value.phase === "body" ? { registryPhase: value.phase } : {}),
    code:
      code ??
      (error instanceof SyntaxError
        ? "REGISTRY_BAD_JSON"
        : value.timedOut === true
          ? "COMMAND_TIMEOUT"
          : "UNKNOWN"),
    ...(typeof value.code === "number" && Number.isSafeInteger(value.code)
      ? { exitCode: value.code }
      : {}),
  };
}
