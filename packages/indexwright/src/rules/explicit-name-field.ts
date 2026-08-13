import { uniqueSorted } from '../collections.js';
import { NAME_FIELD } from '../key.js';
import type { Finding, Rule, RuleContext } from '../types.js';

/**
 * R3 · explicit-name-field — a trailing `__name__` that restates what Firestore appends anyway.
 *
 * Firestore appends the document key implicitly; live exports render it explicitly. A redundant
 * `__name__` in a hand-maintained file is therefore a signature of a value that round-tripped
 * through an export. It does not change the resource, but it makes the file inconsistent and can
 * mask genuine duplicates from naive text comparison.
 *
 * A `__name__` whose direction differs from the implicit default is meaningful and is not flagged.
 */
export const explicitNameField: Rule = {
  id: 'explicit-name-field',
  description: `a trailing ${NAME_FIELD} that restates the direction Firestore appends implicitly`,

  check(context: RuleContext): Finding[] {
    const flagged = context.indexes.filter((index) => index.redundantNameDirection !== null);
    // Two byte-identical declarations produce one key and would render as two identical lines.
    const keys = uniqueSorted(flagged.map((index) => index.key));

    return keys.map((key): Finding => {
      const index = flagged.find((candidate) => candidate.key === key);
      const direction = index?.redundantNameDirection ?? 'ASCENDING';
      return {
        rule: 'explicit-name-field',
        file: context.file,
        key,
        message:
          `the index ends with an explicit ${NAME_FIELD} (${direction}), which is the direction ` +
          `Firestore appends implicitly. The entry names the same index either way; writing it ` +
          `the shorter way keeps the file comparable by text.`,
        related: [],
      };
    });
  },
};
