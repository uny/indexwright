/**
 * The baseline file: gaps a project has accepted, read back (SPEC §3, and issue #57).
 *
 * A baseline names keys that `check` should report and not fail on. It exists because the verb has
 * no other adoption path: a project of any age discovers all of its existing gaps in one run, and a
 * check that cannot be introduced without fixing every one of them first goes in behind `|| true`
 * and stops being read. Holding the line where it is, and failing on anything new, is the shape that
 * survives contact with a pipeline.
 *
 * Two things it is not, and both are enforced here rather than left to convention:
 *
 * - *A suppression file that outlives its reason.* Every entry carries a `reason`, and an empty one
 *   is refused. There is no mechanical way to tell a justified entry from one added to make a build
 *   green, so the only thing this reader can do is insist that somebody wrote a sentence — and the
 *   report prints it back on every run, where it is re-read rather than accumulated.
 * - *A substitute for SPEC §2.* A baselined entry is still a query the candidate set does not serve.
 *   The report says so in the same words it uses for any other gap; what the baseline changes is the
 *   exit code, and nothing else.
 *
 * Nothing writes this file. Generating one from a run would produce exactly the artefact the first
 * point forbids — a list of keys with no reasons — so the keys are printed by the report and the
 * file is written by hand.
 *
 * The reader refuses rather than repairs, for the reason `corpus.ts` does: a misread entry either
 * silences a gap nobody accepted or fails a build over one somebody did.
 */

/** A baseline that cannot be read as one. Never a repair, always a refusal. */
export class BaselineError extends Error {
  override readonly name = 'BaselineError';
}

/**
 * The format this version writes and reads.
 *
 * Present from the first release, and separate from `CORPUS_VERSION`: the two files are edited by
 * different hands on different schedules, and a corpus bump that forced every baseline to be
 * rewritten would be a bump nobody could afford to make. #55 is the case study for what an
 * unversioned strict reader costs later.
 */
export const BASELINE_VERSION = 1;

/** One accepted gap: the key it is accepted for, and why. */
export interface AcceptedGap {
  /** The §7 canonical query key, matched exactly. */
  readonly key: string;
  /** Why this gap is accepted. Non-empty, and printed by every run that matches it. */
  readonly reason: string;
}

export interface Baseline {
  readonly baselineVersion: number;
  readonly accepted: readonly AcceptedGap[];
}

export function parseBaseline(source: string): Baseline {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new BaselineError(`not valid JSON: ${(error as Error).message}`);
  }

  const root = expectObject(document, 'the baseline');

  // Before the member set, for the reason `parseCorpus` checks it first: adding a member is the
  // normal reason to bump, so testing membership first would answer a future baseline with a
  // complaint about a stray field instead of the version mismatch that explains it.
  const version = root['baselineVersion'];
  if (version !== BASELINE_VERSION) {
    throw new BaselineError(
      `baselineVersion ${describeVersion(version)} is not readable by this version, which reads ${BASELINE_VERSION}`,
    );
  }

  expectExactMembers(root, ['baselineVersion', 'accepted'], 'the baseline');

  const accepted = expectArray(root['accepted'], 'accepted').map((entry, index) =>
    parseAccepted(entry, `accepted[${index}]`),
  );

  // Unique, but deliberately not sorted — the one place this reader is looser than `parseCorpus`.
  // A corpus is machine-written and its sort is what makes two recorders that saw the same queries
  // write the same bytes; a baseline is written and re-written by hand, and refusing it for being in
  // the order somebody added the entries in would be a refusal about nothing. Duplicates are still
  // refused: two reasons for one key leaves the report choosing which one to print.
  const seen = new Set<string>();
  for (const entry of accepted) {
    if (seen.has(entry.key)) {
      throw new BaselineError(`two entries share the key ${JSON.stringify(entry.key)}`);
    }
    seen.add(entry.key);
  }

  return { baselineVersion: BASELINE_VERSION, accepted };
}

function parseAccepted(value: unknown, at: string): AcceptedGap {
  const entry = expectObject(value, at);
  expectExactMembers(entry, ['key', 'reason'], at);

  const key = expectString(entry['key'], `${at}.key`);
  // Not validated as a well-formed §7 key beyond being a string. A key this version cannot parse is
  // one it also cannot have produced, so it matches nothing and is reported as an entry that no
  // longer reproduces — which is the outcome, and a better one than refusing the whole file over an
  // entry left behind by an older corpus.
  if (key === '') throw new BaselineError(`${at}.key is empty`);

  const reason = expectString(entry['reason'], `${at}.reason`);
  // Whitespace is not a reason. The check is the whole of what stops a baseline from becoming a
  // suppression list, so a `" "` that satisfies a length test would satisfy nothing else.
  if (reason.trim() === '') {
    throw new BaselineError(
      `${at}.reason is empty; an entry with no reason cannot be told from one added to make a run pass`,
    );
  }

  return { key, reason };
}

/**
 * A version value as one bounded phrase, for the message that refuses it.
 *
 * @see corpus.ts — the same rule, and the same reason for it: a deep enough nested value parses and
 * then overflows on the way to being refused, out of a reader documented to fail one way.
 */
function describeVersion(value: unknown): string {
  if (typeof value === 'object' && value !== null) return Array.isArray(value) ? '[...]' : '{...}';
  return JSON.stringify(value) ?? String(value);
}

function expectObject(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BaselineError(`${at} is not an object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new BaselineError(`${at} is not an array`);
  return value;
}

function expectString(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new BaselineError(`${at} is not a string`);
  return value;
}

/** @see corpus.ts — the same rule, and the same reason for it. */
function expectExactMembers(node: Record<string, unknown>, expected: readonly string[], at: string): void {
  for (const member of expected) {
    if (!(member in node)) throw new BaselineError(`${at} is missing ${member}`);
  }
  for (const member of Object.keys(node)) {
    if (!expected.includes(member)) {
      throw new BaselineError(`${at} carries ${JSON.stringify(member)}, which this format does not define`);
    }
  }
}
