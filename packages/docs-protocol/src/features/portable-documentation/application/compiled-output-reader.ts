/** Provider output is encoded data; neither a YAML node nor a mutable byte buffer crosses this port. */
export interface CompiledOutput {
  readonly contentBase64: string;
  readonly digest: `sha256:${string}`;
  readonly mediaType: "text/markdown; charset=utf-8";
  readonly size: number;
}

export interface DecodedCompiledOutput {
  readonly content: string;
  readonly frontmatter: string;
  readonly metadata: unknown;
}

export interface CompiledOutputReader {
  read(output: CompiledOutput): DecodedCompiledOutput;
}
