import {
  compareLeafInventories,
  type ComparisonResult,
  type InputLeaf,
  type LeafInventory,
} from '@agent-teams/ci-input-proof';

const closedFile: InputLeaf = {
  path: 'package.json',
  type: 'file',
  mode: '100644',
  membership: 'closed',
  content: '1'.repeat(64),
};
const executableFile: InputLeaf = {
  path: 'scripts/run.mts',
  type: 'file',
  mode: '100755',
  membership: 'closed',
  content: '2'.repeat(64),
};
const symlink: InputLeaf = {
  path: 'scripts/current',
  type: 'symlink',
  mode: '120000',
  membership: 'closed',
  content: '3'.repeat(64),
};
const gitlink: InputLeaf = {
  path: 'vendor/fixture',
  type: 'gitlink',
  mode: '160000',
  membership: 'structural',
  content: '4'.repeat(64),
};

export const before: LeafInventory = {
  version: 1,
  digestScheme: 'sha256',
  inputs: [closedFile, executableFile, symlink, gitlink],
};

export const after: LeafInventory = {
  ...before,
  inputs: [closedFile, executableFile, symlink, { ...gitlink, content: '5'.repeat(64) }],
};

export function typedPublicApiReference(): ComparisonResult {
  return compareLeafInventories(before, after, ['vendor/fixture']);
}

function invalidTypeModePairsOnly(): readonly InputLeaf[] {
  // @ts-expect-error File leaves must use a file mode.
  const invalidFile: InputLeaf = {
    path: 'invalid-file',
    type: 'file',
    mode: '120000',
    membership: 'closed',
    content: '6'.repeat(64),
  };
  // @ts-expect-error Symlink leaves must use the symlink mode.
  const invalidSymlink: InputLeaf = {
    path: 'invalid-symlink',
    type: 'symlink',
    mode: '160000',
    membership: 'closed',
    content: '7'.repeat(64),
  };
  // @ts-expect-error Gitlink leaves must use the gitlink mode.
  const invalidGitlink: InputLeaf = {
    path: 'invalid-gitlink',
    type: 'gitlink',
    mode: '100644',
    membership: 'closed',
    content: '8'.repeat(64),
  };
  return [invalidFile, invalidSymlink, invalidGitlink];
}

void invalidTypeModePairsOnly;
