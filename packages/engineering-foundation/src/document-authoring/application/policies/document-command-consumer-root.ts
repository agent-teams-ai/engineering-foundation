const utf8 = new TextEncoder();
const maximumConsumerRootBytes = 512;

export function projectDocumentCommandConsumerRoot(
  consumerRoot: string
): string {
  const isWindowsAbsolute = /^[A-Za-z]:\\/u.test(consumerRoot) ||
    consumerRoot.startsWith("\\\\");
  const projected = isWindowsAbsolute
    ? consumerRoot.replaceAll("\\", "/")
    : consumerRoot;
  if (
    projected.length === 0 ||
    utf8.encode(projected).byteLength > maximumConsumerRootBytes
  ) {
    throw new TypeError(
      `Document command consumer root must contain between 1 and ${maximumConsumerRootBytes} UTF-8 bytes.`
    );
  }
  return projected;
}
