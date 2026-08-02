import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CapabilityInputError } from "../packages/engineering-foundation/dist/capability-runtime.js";
import { FilesystemMarkdownDocumentReader } from "../packages/engineering-foundation/dist/documentation-observation/adapters/outbound/filesystem/filesystem-markdown-document-reader.js";
import { nodeFilesystemMarkdownOperations } from "../packages/engineering-foundation/dist/documentation-observation/adapters/outbound/filesystem/filesystem-markdown-filesystem.js";
import { resolveFilesystemMarkdownReference } from "../packages/engineering-foundation/dist/documentation-observation/adapters/outbound/filesystem/filesystem-markdown-reference-resolver.js";
import { observeFilesystemMarkdownTree } from "../packages/engineering-foundation/dist/documentation-observation/adapters/outbound/filesystem/filesystem-markdown-tree-observer.js";

const MISSING_ERROR_CODES = ["ENOENT", "ENOTDIR"];
const UNAVAILABLE_ERROR_CODES = ["EACCES", "EIO", "EMFILE", "ENOSPC"];
const sourceDocument = Object.freeze({ repositoryPath: "docs/README.md" });

async function withRepository(callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-documentation-filesystem-"));
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "README.md"), "# Documentation\n", "utf8");
    return await callback(await realpath(root));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function filesystem(overrides = {}) {
  return { ...nodeFilesystemMarkdownOperations, ...overrides };
}

function filesystemError(code) {
  const error = new Error(`Injected filesystem failure: ${code}`);
  error.code = code;
  return error;
}

function assertUnavailable(error) {
  assert.ok(error instanceof CapabilityInputError);
  assert.equal(error.problem.code, "DOCUMENTATION_FILESYSTEM_UNAVAILABLE");
  assert.equal(error.problem.phase, "documentation-observation");
  assert.equal(error.problem.retryable, true);
  return true;
}

function assertCancelled(error) {
  assert.ok(error instanceof CapabilityInputError);
  assert.equal(error.problem.code, "EXECUTION_CANCELLED");
  return true;
}

test("treats missing configured Markdown roots as root-missing", async () => {
  for (const code of MISSING_ERROR_CODES) {
    await withRepository(async (root) => {
      const missingRoot = join(root, `missing-${code}`);
      let injected = false;
      const operations = filesystem({
        async lstat(path) {
          if (path === missingRoot) {
            injected = true;
            throw filesystemError(code);
          }
          return nodeFilesystemMarkdownOperations.lstat(path);
        }
      });
      const observation = await observeFilesystemMarkdownTree(
        { consumerRoot: root, roots: [`missing-${code}`] },
        new FilesystemMarkdownDocumentReader(operations),
        operations
      );

      assert.deepEqual(observation, {
        documents: [],
        issues: [
          {
            kind: "root-missing",
            message: "Configured Markdown root does not exist.",
            repositoryPath: `missing-${code}`
          }
        ]
      });
      assert.equal(injected, true, `Expected ${code} fault injection.`);
    });
  }
});

test("propagates unavailable Markdown directory reads as retryable failures", async () => {
  await withRepository(async (root) => {
    const markdownRoot = join(root, "docs");
    const operations = filesystem({
      async readdir(path, ...arguments_) {
        if (path === markdownRoot) {
          throw filesystemError("EACCES");
        }
        return nodeFilesystemMarkdownOperations.readdir(path, ...arguments_);
      }
    });

    await assert.rejects(
      observeFilesystemMarkdownTree(
        { consumerRoot: root, roots: ["docs"] },
        new FilesystemMarkdownDocumentReader(operations),
        operations
      ),
      assertUnavailable
    );
  });
});

test("does not classify unavailable configured-root metadata as root-missing", async () => {
  await withRepository(async (root) => {
    const markdownRoot = join(root, "docs");
    let rootInspections = 0;
    const operations = filesystem({
      async lstat(path) {
        if (path === markdownRoot) {
          rootInspections += 1;
          if (rootInspections === 2) {
            throw filesystemError("EIO");
          }
        }
        return nodeFilesystemMarkdownOperations.lstat(path);
      }
    });

    await assert.rejects(
      observeFilesystemMarkdownTree(
        { consumerRoot: root, roots: ["docs"] },
        new FilesystemMarkdownDocumentReader(operations),
        operations
      ),
      assertUnavailable
    );
    assert.equal(rootInspections, 2);
  });
});

test("treats configured roots that disappear during enumeration as root-missing", async () => {
  for (const code of MISSING_ERROR_CODES) {
    await withRepository(async (root) => {
      const markdownRoot = join(root, "docs");
      let injected = false;
      const operations = filesystem({
        async readdir(path, ...arguments_) {
          if (path === markdownRoot) {
            injected = true;
            throw filesystemError(code);
          }
          return nodeFilesystemMarkdownOperations.readdir(path, ...arguments_);
        }
      });
      const observation = await observeFilesystemMarkdownTree(
        { consumerRoot: root, roots: ["docs"] },
        new FilesystemMarkdownDocumentReader(operations),
        operations
      );

      assert.deepEqual(observation, {
        documents: [],
        issues: [
          {
            kind: "root-missing",
            message: "Configured Markdown root does not exist.",
            repositoryPath: "docs"
          }
        ]
      });
      assert.equal(injected, true, `Expected ${code} fault injection.`);
    });
  }
});

test("treats missing local Markdown targets as missing", async () => {
  for (const code of MISSING_ERROR_CODES) {
    await withRepository(async (root) => {
      const targetPath = join(root, "docs", `missing-${code}.md`);
      let injected = false;
      const operations = filesystem({
        async lstat(path) {
          if (path === targetPath) {
            injected = true;
            throw filesystemError(code);
          }
          return nodeFilesystemMarkdownOperations.lstat(path);
        }
      });
      const resolution = await resolveFilesystemMarkdownReference(
        {
          consumerRoot: root,
          rawTarget: `missing-${code}.md`,
          source: sourceDocument
        },
        new FilesystemMarkdownDocumentReader(operations),
        operations
      );

      assert.deepEqual(resolution, {
        kind: "missing",
        reason: "target-missing",
        repositoryPath: `docs/missing-${code}.md`
      });
      assert.equal(injected, true, `Expected ${code} fault injection.`);
    });
  }
});

test("does not classify unavailable local-target metadata as missing", async () => {
  await withRepository(async (root) => {
    const targetPath = join(root, "docs", "missing.md");
    await writeFile(targetPath, "# Target\n", "utf8");
    const operations = filesystem({
      async readContainedRegularFile(input) {
        if (input.candidate === targetPath) {
          throw filesystemError("EIO");
        }
        return nodeFilesystemMarkdownOperations.readContainedRegularFile(input);
      }
    });

    await assert.rejects(
      resolveFilesystemMarkdownReference(
        { consumerRoot: root, rawTarget: "missing.md", source: sourceDocument },
        new FilesystemMarkdownDocumentReader(operations),
        operations
      ),
      assertUnavailable
    );
  });
});

test("does not convert unavailable Markdown reads into broken links", async () => {
  for (const code of UNAVAILABLE_ERROR_CODES) {
    await withRepository(async (root) => {
      const targetName = `target-${code}.md`;
      const targetPath = join(root, "docs", targetName);
      await writeFile(targetPath, "# Target\n", "utf8");
      const operations = filesystem({
        async readContainedRegularFile(input) {
          if (input.candidate === targetPath) {
            throw filesystemError(code);
          }
          return nodeFilesystemMarkdownOperations.readContainedRegularFile(input);
        }
      });

      await assert.rejects(
        resolveFilesystemMarkdownReference(
          { consumerRoot: root, rawTarget: targetName, source: sourceDocument },
          new FilesystemMarkdownDocumentReader(operations),
          operations
        ),
        assertUnavailable
      );
    });
  }
});

test("does not swallow cancellation after a Markdown directory read", async () => {
  await withRepository(async (root) => {
    const controller = new AbortController();
    const markdownRoot = join(root, "docs");
    const operations = filesystem({
      async readdir(path, ...arguments_) {
        if (path === markdownRoot) {
          controller.abort();
        }
        return nodeFilesystemMarkdownOperations.readdir(path, ...arguments_);
      }
    });

    await assert.rejects(
      observeFilesystemMarkdownTree(
        { consumerRoot: root, roots: ["docs"], signal: controller.signal },
        new FilesystemMarkdownDocumentReader(operations),
        operations
      ),
      assertCancelled
    );
  });
});

test("preserves cancellation while a Markdown reference is being read", async () => {
  await withRepository(async (root) => {
    const controller = new AbortController();
    const targetPath = join(root, "docs", "target.md");
    await writeFile(targetPath, "# Target\n", "utf8");
    const operations = filesystem({
      async readContainedRegularFile(input) {
        if (input.candidate === targetPath) {
          controller.abort();
          throw filesystemError("EIO");
        }
        return nodeFilesystemMarkdownOperations.readContainedRegularFile(input);
      }
    });

    await assert.rejects(
      resolveFilesystemMarkdownReference(
        {
          consumerRoot: root,
          rawTarget: "target.md",
          signal: controller.signal,
          source: sourceDocument
        },
        new FilesystemMarkdownDocumentReader(operations),
        operations
      ),
      assertCancelled
    );
  });
});
