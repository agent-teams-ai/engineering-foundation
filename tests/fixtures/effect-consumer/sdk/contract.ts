export type SessionId = "left" | "right";

export interface Progress {
  readonly sessionId: SessionId;
  readonly revision: number;
  readonly completed: number;
}

export type Frame =
  | { readonly kind: "ready"; readonly sessionId: SessionId }
  | (Progress & { readonly kind: "progress" });

export class ProtocolError extends Error {
  readonly _tag = "ProtocolError";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolError";
  }
}

export class TransportError extends Error {
  readonly _tag = "TransportError";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransportError";
  }
}

export const maxFrameBytes = 4096;

export function sessionId(value: string | null): SessionId {
  if (value !== "left" && value !== "right") throw new ProtocolError("Unknown session");
  return value;
}
