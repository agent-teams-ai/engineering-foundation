import assert from "node:assert/strict";
import { basename, resolve } from "node:path";
import { version } from "typescript";
import type { SourceFile } from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API, type Checker, type Diagnostic } from "typescript/unstable/sync";

/** Test-only compiler session: native syntax and lexical lookup, with no disk inputs. */
export class NativeSourceParser {
  readonly #cwd = process.cwd();
  readonly #config = resolve(this.#cwd, "__source_parser_oracle__", "tsconfig.json").replaceAll("\\", "/");
  readonly #fs = createVirtualFileSystem({});
  readonly #api: API;
  #previousFile: string | undefined;
  #sequence = 0;

  constructor() {
    assert.equal(version, "7.0.2", "the parser oracle uses the exact pinned native compiler");
    // Missing virtual files never fall through to a consumer's real dependencies.
    const readFile = this.#fs.readFile!;
    const entries = this.#fs.getAccessibleEntries!;
    this.#fs.readFile = path => readFile(path) ?? null;
    this.#fs.getAccessibleEntries = path => entries(path) ?? { files: [], directories: [] };
    this.#api = new API({ cwd: this.#cwd, fs: this.#fs });
  }

  inspect<T>(filename: string, source: string, inspect: (
    tree: SourceFile, checker: Checker, diagnostics: readonly Diagnostic[],
  ) => T): T {
    const previousFile = this.#previousFile;
    // A new identity forces actual parsing even when the benchmark repeats bytes.
    // Only the current source remains in the virtual filesystem and project.
    const file = resolve(this.#cwd, "__source_parser_oracle__", `${this.#sequence++}-${basename(filename)}`).replaceAll("\\", "/");
    this.#fs.writeFile!(file, source);
    if (previousFile !== undefined) { this.#fs.removeFile!(previousFile); }
    this.#fs.writeFile!(this.#config, JSON.stringify({
      compilerOptions: { allowJs: true, noEmit: true, noLib: true, noResolve: true, types: [],
        target: "ESNext", module: "ESNext", moduleResolution: "Bundler", jsx: "preserve" },
      files: [file], include: [], exclude: [],
    }));
    const snapshot = this.#api.updateSnapshot(previousFile === undefined
      ? { openProjects: [this.#config] }
      : { fileChanges: { changed: [this.#config], created: [file], deleted: [previousFile] } });
    this.#previousFile = file;
    try {
      const project = snapshot.getProject(this.#config);
      assert(project, "native parser project must exist");
      const tree = project.program.getSourceFile(file);
      assert(tree, `native parser source must exist: ${filename}`);
      return inspect(tree, project.checker, project.program.getSyntacticDiagnostics(file));
    } finally {
      snapshot.dispose();
    }
  }

  close(): void { this.#api.close(); }
}
