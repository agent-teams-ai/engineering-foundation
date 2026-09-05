import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";

import type { CodeAnchorMatcher } from "../../application/model.js";

const MAX_PATTERNS = 1_024;
const MAX_CORPUS_FILES = 50_000;
const MAX_CORPUS_PATH_BYTES = 8 * 1024 * 1024;
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function realFileAncestry(root: string, repositoryPath: string): Promise<boolean> {
  let current = root;
  for (const segment of repositoryPath.split("/")) {
    current = resolve(current, segment);
    const state = await lstat(current);
    if (state.isSymbolicLink()) {return false;}
  }
  const state = await lstat(current);
  return state.isFile() && contained(root, await realpath(current));
}

export class NodeCodeAnchorMatcher implements CodeAnchorMatcher {
  async matchedPatterns(input: Parameters<CodeAnchorMatcher["matchedPatterns"]>[0]): Promise<readonly string[]> {
    if (input.patterns.length > MAX_PATTERNS) {
      throw new RangeError(`Code anchor matcher exceeds the ${MAX_PATTERNS}-pattern budget.`);
    }
    const root = await realpath(resolve(input.consumerRoot));
    const files: string[] = [];
    let pathBytes = 0;
    const pending = [""];
    while (pending.length > 0) {
      input.signal?.throwIfAborted();
      const directory = pending.pop()!;
      const entries = (await readdir(resolve(root, directory), { withFileTypes: true }))
        .toSorted((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
      const childDirectories: string[] = [];
      for (const entry of entries) {
        input.signal?.throwIfAborted();
        const repositoryPath = directory === "" ? entry.name : `${directory}/${entry.name}`;
        const state = await lstat(resolve(root, repositoryPath));
        if (state.isSymbolicLink()) {continue;}
        if (state.isDirectory() && !EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
          childDirectories.push(repositoryPath);
        } else if (state.isFile() && await realFileAncestry(root, repositoryPath)) {
          pathBytes += Buffer.byteLength(repositoryPath);
          if (files.length >= MAX_CORPUS_FILES || pathBytes > MAX_CORPUS_PATH_BYTES) {
            throw new RangeError(`Code anchor corpus exceeds the ${MAX_CORPUS_FILES}-file or ${MAX_CORPUS_PATH_BYTES}-byte path budget.`);
          }
          files.push(repositoryPath);
        }
      }
      // Reverse push preserves bytewise ascending traversal with a LIFO stack.
      for (const child of childDirectories.toReversed()) {pending.push(child);}
    }
    const matched = input.patterns.filter((pattern) => files.some((repositoryPath) => matchesGlob(repositoryPath, pattern)));
    return Object.freeze(matched);
  }
}
