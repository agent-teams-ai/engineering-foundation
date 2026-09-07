/** Source text observed for this capability; no parser or filesystem representation escapes. */
export interface SourceFileSnapshot {
  readonly path: string;
  readonly source: string;
}
