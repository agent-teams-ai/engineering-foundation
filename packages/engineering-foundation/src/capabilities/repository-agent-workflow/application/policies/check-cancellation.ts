/** Read the current signal after asynchronous boundaries. A cached/narrowed
 * pre-await boolean cannot describe mid-command cancellation. */
export function isCheckCancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}
