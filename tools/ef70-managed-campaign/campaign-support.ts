import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostedEnvironment } from "./campaign-host.ts";
import {
  absolute,
  contained,
  digest,
  executeCommand,
  fileDigest,
  jsonFile,
  newJson,
  row,
  text,
  type Case,
  type CommandOptions,
  type CommandResult,
  type FileImage,
  type HelperResult,
  type PreparedCase,
  type RecordedCommand,
  type Row,
  type SelectedFile,
} from "./campaign-io.ts";
export {
  digest,
  jsonFile,
  row,
  text,
  type Case,
  type CommandResult,
  type FileImage,
  type HelperResult,
  type PreparedCase,
  type Row,
  type SelectedFile,
} from "./campaign-io.ts";

type Helper = "driver" | "refusal" | "cold" | "cold-committed" | "activation-failure";
const sourceRevision = "8c16e5dbf24d8a09d9f33fe7c3ee8f38bf74599c";
const sourceTree = "026e5c38b568e4a0ff9aa3487f996671accc303a";
const sourceOrigin = "https://github.com/agent-teams-ai/extension-foundation.git";
const helperFiles: Record<Helper, readonly [string, string]> = {
  driver: ["driver.ts", "operation-complete.json"],
  refusal: ["refusal.ts", "refusal-complete.json"],
  cold: ["cold-interruption.ts", "cold-interruption-complete.json"],
  "cold-committed": ["cold-committed-interruption.ts", "cold-committed-interruption-complete.json"],
  "activation-failure": ["activation-failure.ts", "activation-failure-observed.json"],
};

/** Finite disposable-fixture orchestration; public helpers retain protocol decisions. */
export class Campaign {
  readonly root: string;
  readonly evidenceRoot: string;
  readonly sourceRoot: string;
  readonly centralRoot: string;
  readonly controllerInstallation: string;
  readonly node24Executable: string;
  readonly node26Executable: string;
  readonly corepackEntrypoint: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly toolsRoot = dirname(fileURLToPath(import.meta.url));
  readonly bootstrap: Row;
  readonly calls: Row[] = [];
  private commandNumber = 0;
  private callNumber = 0;

  constructor(bootstrapPath: string) {
    this.bootstrap = jsonFile(bootstrapPath);
    assert.equal(this.bootstrap["schemaVersion"], 1);
    this.root = absolute(this.bootstrap["root"], "owned case root");
    this.evidenceRoot = absolute(this.bootstrap["evidenceRoot"], "external evidence root");
    this.sourceRoot = absolute(this.bootstrap["sourceRoot"], "authenticated source");
    this.centralRoot = absolute(this.bootstrap["centralRoot"], "qualified Central checkout");
    this.controllerInstallation = absolute(
      this.bootstrap["controllerInstallation"],
      "retained installation",
    );
    this.node24Executable = realpathSync(absolute(this.bootstrap["node24Executable"], "Node24"));
    this.node26Executable = realpathSync(absolute(this.bootstrap["node26Executable"], "Node26"));
    this.corepackEntrypoint = realpathSync(
      absolute(this.bootstrap["corepackEntrypoint"], "Corepack"),
    );
    for (const path of [
      this.root,
      this.evidenceRoot,
      this.sourceRoot,
      this.centralRoot,
      this.controllerInstallation,
    ]) {
      assert.equal(realpathSync(path), path);
      assert(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink());
    }
    for (const path of [this.sourceRoot, this.centralRoot, this.controllerInstallation]) {
      contained(this.root, path);
    }
    assert(!this.evidenceRoot.startsWith(`${this.root}/`) && this.evidenceRoot !== this.root);
    assert.equal(process.versions.node, "26.12.1");
    assert.equal(realpathSync(process.execPath), this.node26Executable);
    assert.equal(this.bootstrap["sourceRevision"], sourceRevision);
    assert.equal(this.bootstrap["sourceTree"], sourceTree);
    const { environment, harnessRevision } = hostedEnvironment(this.bootstrap);
    this.environment = environment;
    mkdirSync(join(this.evidenceRoot, "orchestration"), { recursive: false, mode: 0o700 });
    this.record("campaign-start", {
      bootstrap: this.selected(bootstrapPath),
      observedAt: new Date().toISOString(),
      hostRepository: process.env["GITHUB_REPOSITORY"],
      hostRevision: process.env["GITHUB_SHA"],
      harnessRevision,
      harnessTree: this.bootstrap["harnessTree"],
      producerPreflight: this.bootstrap["producerPreflight"],
      hostRun: process.env["GITHUB_RUN_ID"],
      hostAttempt: process.env["GITHUB_RUN_ATTEMPT"],
      consumerRepository: "agent-teams-ai/extension-foundation",
      consumerRepositoryId: 1333298097,
      scope:
        "Disposable actual published-controller mechanism evidence; no hosted EF admission, enrollment, release or CANARY grant.",
    });
  }

  selected(path: string): SelectedFile {
    const canonical = absolute(path, "selected evidence");
    const stat = lstatSync(canonical);
    assert(
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 32 * 1024 * 1024,
    );
    return { path: canonical, sha256: fileDigest(canonical) };
  }

  record(name: string, value: unknown): void {
    assert(/^[a-z0-9][a-z0-9-]{0,150}$/u.test(name), name);
    newJson(join(this.evidenceRoot, "orchestration", `${name}.json`), value);
  }

  command(
    label: string,
    executable: string,
    args: readonly string[],
    cwd: string,
    options: CommandOptions = {},
  ): CommandResult {
    return this.execute(label, executable, args, cwd, {
      environment: options.environment ?? this.environment,
      accepted: options.accepted ?? [0],
      observer: false,
    });
  }

  private execute(
    label: string,
    executable: string,
    args: readonly string[],
    cwd: string,
    options: Pick<RecordedCommand, "environment" | "accepted" | "observer" | "timeoutMs">,
  ): CommandResult {
    return executeCommand({
      ...options,
      label,
      executable,
      args,
      cwd,
      stem: join(this.evidenceRoot, "orchestration", `${++this.commandNumber}-${label}`),
    });
  }

  git(root: string, label: string, args: readonly string[]): string {
    return this.command(label, "/usr/bin/git", args, root).stdout.toString("utf8").trimEnd();
  }

  images(root: string, label: string): readonly FileImage[] {
    const names = this.command(`${label}-paths`, "/usr/bin/git", ["ls-files", "-z"], root)
      .stdout.toString("utf8")
      .split("\0")
      .filter(Boolean)
      .toSorted();
    assert(names.length > 0 && names.length <= 10_000 && new Set(names).size === names.length);
    return names.map((path) => {
      const absolutePath = resolve(root, path);
      contained(root, absolutePath);
      const stat = lstatSync(absolutePath);
      const kind = stat.isSymbolicLink() ? "symlink" : "file";
      assert(stat.isSymbolicLink() || stat.isFile());
      return {
        path,
        kind,
        mode: stat.mode & 0o777,
        sha256: kind === "symlink" ? digest(readlinkSync(absolutePath)) : fileDigest(absolutePath),
      };
    });
  }

  private freshCase(name: string): { root: string; evidence: string } {
    assert(/^[a-z0-9][a-z0-9-]{0,50}$/u.test(name));
    const root = join(this.root, `case-${name}`),
      evidence = join(this.evidenceRoot, `case-${name}`);
    assert(!existsSync(root) && !existsSync(evidence));
    mkdirSync(evidence, { recursive: false, mode: 0o700 });
    mkdirSync(join(evidence, "selections"), { recursive: false, mode: 0o700 });
    mkdirSync(join(evidence, "proofs"), { recursive: false, mode: 0o700 });
    return { root, evidence };
  }

  private selection(root: string, evidence: string): Row {
    return {
      schemaVersion: 1,
      sourceRevision,
      consumerRoot: root,
      centralRoot: this.centralRoot,
      authorityRevision: this.bootstrap["authorityRevision"],
      candidate: this.bootstrap["candidate"],
      controllerInstallation: this.controllerInstallation,
      node24Executable: this.node24Executable,
      node26Executable: this.node26Executable,
      corepackEntrypoint: this.corepackEntrypoint,
      targetLock: this.bootstrap["targetLock"],
      completionPath: join(evidence, "proofs/completion.json"),
    };
  }

  createCase(name: string): Case {
    const { root, evidence } = this.freshCase(name);
    this.command(
      `${name}-clone`,
      "/usr/bin/git",
      ["clone", "--no-hardlinks", "--no-checkout", this.sourceRoot, root],
      this.root,
    );
    this.git(root, `${name}-checkout`, ["checkout", "--detach", sourceRevision]);
    this.git(root, `${name}-origin`, ["remote", "set-url", "origin", sourceOrigin]);
    assert.equal(this.git(root, `${name}-head`, ["rev-parse", "HEAD"]), sourceRevision);
    assert.equal(this.git(root, `${name}-tree`, ["rev-parse", "HEAD^{tree}"]), sourceTree);
    const before = this.images(root, `${name}-source-before`);
    assert.equal(before.length, 452);
    this.install(root, `${name}-source-install`, "11.18.0");
    assert.deepEqual(this.images(root, `${name}-source-after`), before);
    assert.equal(
      this.git(root, `${name}-clean`, ["status", "--porcelain=v1", "--untracked-files=no"]),
      "",
    );
    this.record(`${name}-source-ready`, {
      root,
      device: lstatSync(root).dev,
      inode: lstatSync(root).ino,
      sourceRevision,
      sourceTree,
      images: before,
      actualSourceFrozenInstallation: true,
    });
    return { name, root, evidence, selection: this.selection(root, evidence) };
  }

  install(root: string, label: string, manager: "11.18.0" | "11.20.0"): void {
    const version = this.command(
      `${label}-manager`,
      this.node26Executable,
      [this.corepackEntrypoint, "pnpm", "--version"],
      root,
    )
      .stdout.toString("utf8")
      .trim();
    assert.equal(version, manager);
    this.command(
      label,
      this.node26Executable,
      [
        this.corepackEntrypoint,
        "pnpm",
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--ignore-pnpmfile",
        "--package-import-method=copy",
        "--verify-store-integrity",
      ],
      root,
    );
  }

  cloneCurrent(name: string, original: PreparedCase): PreparedCase {
    assert.equal(
      this.git(original.root, `${name}-original-clean`, [
        "status",
        "--porcelain=v1",
        "--untracked-files=no",
      ]),
      "",
    );
    const head = this.git(original.root, `${name}-original-head`, ["rev-parse", "HEAD"]);
    const tree = this.git(original.root, `${name}-original-tree`, ["rev-parse", "HEAD^{tree}"]);
    const { root, evidence } = this.freshCase(name);
    this.command(
      `${name}-clone-current`,
      "/usr/bin/git",
      ["clone", "--no-hardlinks", "--no-checkout", original.root, root],
      this.root,
    );
    this.git(root, `${name}-checkout-current`, ["checkout", "--detach", head]);
    this.git(root, `${name}-origin-current`, ["remote", "set-url", "origin", sourceOrigin]);
    assert.equal(this.git(root, `${name}-current-tree`, ["rev-parse", "HEAD^{tree}"]), tree);
    const before = this.images(root, `${name}-target-before`);
    this.install(root, `${name}-target-install`, "11.20.0");
    assert.deepEqual(this.images(root, `${name}-target-after`), before);
    assert.equal(
      this.git(root, `${name}-current-clean`, ["status", "--porcelain=v1", "--untracked-files=no"]),
      "",
    );
    this.record(`${name}-current-root-ready`, {
      root,
      head,
      tree,
      originalRoot: original.root,
      originalPreparation: original.preparation,
      device: lstatSync(root).dev,
      inode: lstatSync(root).ino,
      actualTargetFrozenInstallation: true,
      images: before,
    });
    return {
      name,
      root,
      evidence,
      preparation: original.preparation,
      selection: {
        ...this.selection(root, evidence),
        completionPath: original.selection["completionPath"],
      },
    };
  }

  prepare(selectedCase: Case): PreparedCase {
    this.call(selectedCase, "driver", "prepare", { operation: "prepare" });
    const preparation = this.selected(
      `${text(selectedCase.selection["completionPath"], "completion")}.prepared`,
    );
    return { ...selectedCase, preparation };
  }

  call(selectedCase: Case | PreparedCase, kind: Helper, label: string, fields: Row): HelperResult {
    assert(/^[a-z0-9][a-z0-9-]{0,80}$/u.test(label));
    const sequence = `${++this.callNumber}-${label}`;
    const input = join(selectedCase.evidence, "selections", `${sequence}.json`);
    const output = join(selectedCase.evidence, sequence);
    const selection: Row = {
      ...selectedCase.selection,
      ...("preparation" in selectedCase ? { preparation: selectedCase.preparation } : {}),
      ...fields,
    };
    const selectedRoot = absolute(selection["consumerRoot"], "actual selected consumer");
    contained(this.root, selectedRoot);
    assert.equal(realpathSync(selectedRoot), selectedRoot);
    assert(/^case-[a-z0-9][a-z0-9-]{0,63}$/u.test(relative(this.root, selectedRoot)));
    assert(typeof selection["operation"] === "string");
    newJson(input, selection);
    assert(!existsSync(output));
    const [helper, resultName] = helperFiles[kind];
    const guardPath = join(selectedCase.evidence, `${sequence}.compiler-guard.jsonl`);
    const environment = {
      ...this.environment,
      EF_CAMPAIGN_OUTPUT: output,
      EF70_COMPILER_GUARD_LOG: guardPath,
      NODE_OPTIONS: `--import=${join(this.toolsRoot, "compiler-guard.ts")}`,
    };
    const before = {
      input: this.selected(input),
      helper: this.selected(join(this.toolsRoot, "stage-b", helper)),
      root: selectedRoot,
      device: lstatSync(selectedRoot).dev,
      inode: lstatSync(selectedRoot).ino,
    };
    // Published M consumes anonymous REST calls. This observes budget before the
    // one actual invocation; it neither reserves budget nor retries an operation.
    // The selected release uses at most eight core REST reads in one public
    // operation; four extra observed requests leave a margin without a guarantee.
    const rateBudget = selection["operation"] === "check-target" ? 0 : 12;
    if (rateBudget > 0) {
      const rateScript = join(this.toolsRoot, "rate-budget.ts");
      const rateBefore = this.selected(rateScript);
      const rateOutput = join(selectedCase.evidence, `${sequence}.rate-budget.json`);
      this.execute(
        `${selectedCase.name}-${sequence}-rate-budget`,
        this.node26Executable,
        [rateScript, rateOutput, String(rateBudget)],
        this.toolsRoot,
        { environment: this.environment, accepted: [0], observer: false, timeoutMs: 70 * 60_000 },
      );
      assert.deepEqual(this.selected(rateScript), rateBefore);
      const observation = jsonFile(rateOutput);
      assert.equal(observation["sufficientBudgetObserved"], true);
      assert.equal(observation["minimumObservedRequests"], rateBudget);
      assert.deepEqual(this.selected(input), before.input);
      this.record(`rate-${sequence}-${selectedCase.name}`, {
        script: rateBefore,
        result: this.selected(rateOutput),
        rateBudget,
        scope:
          "Shared-IP snapshot only; the unchanged public invocation still owns authority and rate-limit failures.",
      });
    }
    const command = this.execute(
      `${selectedCase.name}-${sequence}`,
      this.node26Executable,
      [join(this.toolsRoot, "stage-b", helper), input],
      this.toolsRoot,
      { environment, accepted: [0], observer: true },
    );
    assert.deepEqual(this.selected(input), before.input);
    assert.deepEqual(this.selected(join(this.toolsRoot, "stage-b", helper)), before.helper);
    assert.equal(lstatSync(selectedRoot).dev, before.device);
    assert.equal(lstatSync(selectedRoot).ino, before.inode);
    const result = jsonFile(join(output, resultName));
    const record = {
      case: selectedCase.name,
      kind,
      label,
      output,
      before,
      status: command.status,
      result: this.selected(join(output, resultName)),
    };
    this.calls.push(record);
    this.record(`helper-${sequence}-${selectedCase.name}`, record);
    return { output, result };
  }

  operation(
    selectedCase: PreparedCase,
    operation: "finalize" | "check-target" | "restore" | "restore-committed",
    expectedReceiptOutcome?: "applied" | "already-satisfied",
  ): HelperResult {
    return this.call(selectedCase, "driver", operation, {
      operation,
      ...(expectedReceiptOutcome === undefined ? {} : { expectedReceiptOutcome }),
    });
  }

  commit(
    selectedCase: PreparedCase,
    label: string,
    subject: string,
    paths: readonly string[],
  ): { head: string; tree: string } {
    assert(paths.length > 0 && new Set(paths).size === paths.length);
    for (const path of paths) {
      contained(selectedCase.root, resolve(selectedCase.root, path));
    }
    const policy = jsonFile(join(this.centralRoot, "governance/commit-author-identity.json"));
    const owner = row(policy["owner"], "canonical fixture commit identity");
    this.git(selectedCase.root, `${label}-add`, ["add", "--", ...paths]);
    const staged = this.git(selectedCase.root, `${label}-staged`, [
      "diff",
      "--cached",
      "--name-only",
    ])
      .split("\n")
      .filter(Boolean)
      .toSorted();
    assert.deepEqual(staged, [...paths].toSorted());
    this.git(selectedCase.root, `${label}-commit`, [
      "-c",
      `user.name=${text(owner["name"], "owner name")}`,
      "-c",
      `user.email=${text(owner["email"], "owner email")}`,
      "commit",
      "-m",
      subject,
    ]);
    assert.equal(
      this.git(selectedCase.root, `${label}-clean`, [
        "status",
        "--porcelain=v1",
        "--untracked-files=no",
      ]),
      "",
    );
    const head = this.git(selectedCase.root, `${label}-head`, ["rev-parse", "HEAD"]);
    const tree = this.git(selectedCase.root, `${label}-tree`, ["rev-parse", "HEAD^{tree}"]);
    this.record(`${label}-committed`, {
      head,
      tree,
      paths,
      subject,
      root: selectedCase.root,
      authority:
        "Local disposable test commit only; never a published consumer or producer commit.",
    });
    return { head, tree };
  }
}
