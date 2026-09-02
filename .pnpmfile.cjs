const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function compareKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedRecord(value) {
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => compareKeys(left, right)));
}

module.exports = {
  hooks: {
    beforePacking(manifest) {
      const normalized = { ...manifest };
      for (const field of DEPENDENCY_FIELDS) {
        if (normalized[field] !== undefined) {
          normalized[field] = sortedRecord(normalized[field]);
        }
      }
      return Object.fromEntries(Object.entries(normalized).toSorted(([left], [right]) => compareKeys(left, right)));
    },
  },
};
