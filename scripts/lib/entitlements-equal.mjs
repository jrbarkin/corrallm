// Compares the entitlements a signed binary carries (an XML plist on stdin, as
// `codesign --display --entitlements :-` prints it) with a committed plist (argv[2]).
//   codesign -d --entitlements :- app | node scripts/lib/entitlements-equal.mjs build/x.plist
// Exits 0 when both hold the same keys with the same values, 1 when they differ. A binary signed
// with no entitlements prints nothing, which equals only an empty plist.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The key/value pairs of a flat entitlements plist, sorted, as `key=value` lines. */
export function entitlements(xml) {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const pairs = [];
  const pattern =
    /<key>([^<]*)<\/key>\s*(<true\s*\/>|<false\s*\/>|<string>[^<]*<\/string>|<integer>[^<]*<\/integer>|<array\s*\/>|<array>[\s\S]*?<\/array>)/g;
  for (const [, key, value] of body.matchAll(pattern))
    pairs.push(`${key}=${value.replace(/\s+/g, '')}`);
  return pairs.sort();
}

export function sameEntitlements(a, b) {
  const left = entitlements(a);
  const right = entitlements(b);
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const expected = process.argv[2];
  if (!expected) {
    console.error('Usage: <plist on stdin> | node entitlements-equal.mjs <committed plist>');
    process.exit(2);
  }
  const actual = readFileSync(0, 'utf8');
  process.exit(sameEntitlements(actual, readFileSync(expected, 'utf8')) ? 0 : 1);
}
