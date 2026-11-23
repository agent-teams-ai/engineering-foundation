// Adapted from typescript-eslint 8.59.1 (MIT). See THIRD_PARTY_NOTICES.md and eslint-syntax-provenance.json.
/**
 * Lodash <https://lodash.com/>
 * Released under MIT license <https://lodash.com/license>
 */
const reRegExpChar = /[\\^$.*+?()[\]{}|]/g;
const reHasRegExpChar = RegExp(reRegExpChar.source);

export function escapeRegExp(string = ''): string {
  return string && reHasRegExpChar.test(string)
    ? string.replaceAll(reRegExpChar, '\\$&')
    : string;
}
