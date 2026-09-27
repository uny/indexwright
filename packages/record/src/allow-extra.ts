/**
 * The `--allow-extra` file: extras a project has accepted on a shared target (SPEC §3, issue #92).
 *
 * `check`'s default reconcile is strict in both directions (`reconcile.ts`), which is correct for a
 * throwaway database that CI deploys the candidate set to and nothing else ever touches. It is the
 * wrong model for a shared one: a dev database that a second, hand-maintained tool keeps indexes on
 * between drift runs holds `HEAD ∪ known extras` by design, and a strict reconcile declines on every
 * one of them. `--allow-extra` is the throwaway model's strictness kept — a set the file does not
 * declare is still not vouched for by default, and a set the file declares but the target lacks still
 * declines the run — with a named exception carved out of the *extra* half alone.
 *
 * This is deliberately not `--target-set live` wearing a different flag. Live mode gives up the
 * question "is the file's declared set what's there" entirely; this file keeps asking it, for every
 * key but the ones it names. That is why it mirrors `baseline.ts`'s shape rather than reusing it
 * outright — a baseline forgives a coverage *gap* the corpus still demonstrates (a §7 query key), and
 * this forgives a *presence* divergence the target still carries (a §5 index or override key,
 * `reconcile.ts`'s `identity`/`overrideKey`). The two key spaces are not interchangeable, and a reader
 * of `--allow-extra <baseline-file>` should be refused rather than silently matching nothing — hence
 * the file's own version member, `allowExtraVersion`, rather than borrowing `baselineVersion`.
 *
 * What this file is not, for the same two reasons `baseline.ts` gives:
 *
 * - *A suppression file that outlives its reason.* Every entry carries a `reason`, checked non-empty
 *   past whitespace, exactly as `baseline.ts` checks it — there is no mechanical way to tell a
 *   justified entry from one added to make a build green, so the only thing this reader can insist on
 *   is that somebody wrote a sentence, and `check` prints it back on every run that relies on it.
 * - *An authorisation to delete anything.* SPEC §2 and §8 are unmoved by this file: an entry in it says
 *   "this extra is not this run's problem," never "this index should go." Nothing here, or in `check`,
 *   offers to remove what it names.
 *
 * Nothing writes this file, for the reason nothing writes a baseline: generating one from a run
 * produces exactly the artefact the first point forbids, a list of keys with no reasons.
 */

/** An allow-extra file that cannot be read as one. Never a repair, always a refusal. */
export class AllowExtraError extends Error {
  override readonly name = 'AllowExtraError';
}

/**
 * The format this version writes and reads.
 *
 * A member of its own rather than `BASELINE_VERSION`, and for more than tidiness: the two files hold
 * different key spaces (§7 query keys against §5 index/override keys), so a baseline handed to
 * `--allow-extra` by mistake has to be refused as unreadable rather than silently matching nothing.
 */
export const ALLOW_EXTRA_VERSION = 1;

/** One accepted extra: the §5 key it is accepted for (an index key or an override key), and why. */
export interface AllowedExtra {
  /** The canonical index key or override key of SPEC §5, matched exactly. */
  readonly key: string;
  /** Why this extra is accepted. Non-empty, and printed by every run that matches it. */
  readonly reason: string;
}

export interface AllowExtra {
  readonly allowExtraVersion: number;
  readonly allowed: readonly AllowedExtra[];
}

export function parseAllowExtra(source: string): AllowExtra {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new AllowExtraError(`not valid JSON: ${(error as Error).message}`);
  }

  const root = expectObject(document, 'the allow-extra file');

  // Before the member set, for the reason `parseBaseline` checks it first: adding a member is the
  // normal reason to bump, so testing membership first would answer a future file with a complaint
  // about a stray field instead of the version mismatch that explains it.
  const version = root['allowExtraVersion'];
  if (version !== ALLOW_EXTRA_VERSION) {
    throw new AllowExtraError(
      `allowExtraVersion ${describeVersion(version)} is not readable by this version, which reads ${ALLOW_EXTRA_VERSION}`,
    );
  }

  expectExactMembers(root, ['allowExtraVersion', 'allowed'], 'the allow-extra file');

  const allowed = expectArray(root['allowed'], 'allowed').map((entry, index) =>
    parseAllowed(entry, `allowed[${index}]`),
  );

  // Unique, but deliberately not sorted — the reason `parseBaseline` gives for `accepted`: this file
  // is written and re-written by hand, and refusing it for the order somebody added entries in would
  // be a refusal about nothing. Duplicates are still refused: two reasons for one key leaves the
  // report choosing which one to print.
  const seen = new Set<string>();
  for (const entry of allowed) {
    if (seen.has(entry.key)) {
      throw new AllowExtraError(`two entries share the key ${JSON.stringify(entry.key)}`);
    }
    seen.add(entry.key);
  }

  return { allowExtraVersion: ALLOW_EXTRA_VERSION, allowed };
}

function parseAllowed(value: unknown, at: string): AllowedExtra {
  const entry = expectObject(value, at);
  expectExactMembers(entry, ['key', 'reason'], at);

  const key = expectString(entry['key'], `${at}.key`);
  // Not validated as a well-formed §5 key beyond being a string, for the reason `parseBaseline` gives
  // for `accepted[].key`: a key this version cannot parse is one it also cannot have produced, so it
  // matches nothing on the target and is reported as an entry no longer there — a better outcome than
  // refusing the whole file over an entry left behind by an older target.
  if (key === '') throw new AllowExtraError(`${at}.key is empty`);

  const reason = expectString(entry['reason'], `${at}.reason`);
  // Whitespace is not a reason. The check is the whole of what stops this file from becoming a
  // suppression list, so a `" "` that satisfies a length test would satisfy nothing else.
  if (reason.trim() === '') {
    throw new AllowExtraError(
      `${at}.reason is empty; an entry with no reason cannot be told from one added to make a run pass`,
    );
  }

  return { key, reason };
}

/** @see baseline.ts — the same rule, and the same reason for it. */
function describeVersion(value: unknown): string {
  if (typeof value === 'object' && value !== null) return Array.isArray(value) ? '[...]' : '{...}';
  return JSON.stringify(value) ?? String(value);
}

function expectObject(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AllowExtraError(`${at} is not an object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new AllowExtraError(`${at} is not an array`);
  return value;
}

function expectString(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new AllowExtraError(`${at} is not a string`);
  return value;
}

/** @see baseline.ts — the same rule, and the same reason for it. */
function expectExactMembers(node: Record<string, unknown>, expected: readonly string[], at: string): void {
  for (const member of expected) {
    if (!(member in node)) throw new AllowExtraError(`${at} is missing ${member}`);
  }
  for (const member of Object.keys(node)) {
    if (!expected.includes(member)) {
      throw new AllowExtraError(`${at} carries ${JSON.stringify(member)}, which this format does not define`);
    }
  }
}
