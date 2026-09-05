export interface DocumentFileReadRequest {
  readonly candidate: string;
  readonly maxBytes: number;
  readonly root: string;
}

export type DocumentFileReader = (request: DocumentFileReadRequest) => Promise<Uint8Array>;
