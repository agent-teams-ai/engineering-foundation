function refuse(message: string): never {
  throw new Error(`npm package bootstrap refused: ${message}`);
}
function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    refuse(`${label} must be an exact UTC timestamp with whole seconds.`);
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value.replace("Z", ".000Z")
  ) {
    refuse(`${label} is not a canonical UTC timestamp.`);
  }
  return timestamp;
}

export function assertOneDayGranularTokenWindow({
  createdAt,
  expiresAt,
  now,
}: {
  createdAt: unknown;
  expiresAt: unknown;
  now: unknown;
}): void {
  const created = parseTimestamp(createdAt, "token created_at");
  const expires = parseTimestamp(expiresAt, "token expires_at");
  const current = parseTimestamp(now, "current time");
  if (created > current || expires <= current) {
    refuse("the granular token must already be active and not expired.");
  }
  if (expires - created <= 0 || expires - created > 24 * 60 * 60 * 1_000) {
    refuse("the granular token lifetime must be no more than one day.");
  }
  if (expires - current < 15 * 60 * 1_000) {
    refuse("the granular token must have at least fifteen minutes remaining.");
  }
}
