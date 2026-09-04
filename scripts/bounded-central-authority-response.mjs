import { parseStrictJson } from "../packages/repository-mutation/dist/strict-json.js";

export const MAXIMUM_CENTRAL_AUTHORITY_JSON_BYTES = 8 * 1024 * 1024;

export async function fetchBoundedCentralAuthorityResponse(input, init, fetcher = globalThis.fetch) {
  const response = await fetcher(input, init);
  if (!response.ok) {
    return response;
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) ||
      Number(declaredLength) > MAXIMUM_CENTRAL_AUTHORITY_JSON_BYTES)) {
    throw new Error("Central authority JSON exceeds the byte-size limit.");
  }
  if (response.body === null) {
    throw new Error("Central authority JSON response has no body.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > MAXIMUM_CENTRAL_AUTHORITY_JSON_BYTES) {
        await reader.cancel();
        throw new Error("Central authority JSON exceeds the byte-size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (byteLength === 0) {
    throw new Error("Central authority JSON response is empty.");
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), byteLength);
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parseStrictJson(source);
  } catch (error) {
    throw new Error("Central authority response is not strict duplicate-free UTF-8 JSON.", { cause: error });
  }
  return new Response(bytes, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}
