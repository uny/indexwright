/**
 * Deciding when an index set may be reported on (SPEC §3, *v0.3 — coverage check*).
 *
 * `check` does not apply the candidate index set, but it does have to establish that the set is
 * ready, because a false `FAILED_PRECONDITION` is emitted by `check` no matter who deployed and §2
 * forbids acting on one. A composite index answers `FAILED_PRECONDITION` for a period *after* it can
 * already serve some queries: one query succeeding is not evidence, since a sibling query on the
 * same index can fail immediately afterwards, inconsistently across value types and filter shapes,
 * and the effect vanishes on re-run. Reporting inside that window emits exactly the false positive
 * §2 exists to prevent, and emits it rarely enough to be believed.
 *
 * So readiness is established twice over: every index reports `READY`, *and* the set has been quiet
 * for a settling period. This module is the second half and the bookkeeping for the first. It holds
 * no client and performs no I/O — it is fed observations and a clock — so the rule that decides
 * whether a report is allowed out is testable without waiting on a real index build.
 */

import { compareByCodePoint } from './shape.js';

/**
 * The index states this version knows.
 *
 * `STATE_UNSPECIFIED` is in the list because the Admin API can send it, not because it is
 * actionable; it is classified with the states this module does not recognise.
 */
export const INDEX_STATES = ['STATE_UNSPECIFIED', 'CREATING', 'READY', 'NEEDS_REPAIR'] as const;

export type IndexState = (typeof INDEX_STATES)[number];

/**
 * One index as the Admin API reports it, reduced to what readiness turns on.
 *
 * `state` is a bare `string` rather than `IndexState` on purpose: it arrives from a service that can
 * add a value after this was written, and narrowing it at the type level would only move the
 * unrecognised case out of sight.
 */
export interface LiveIndex {
  /** The full resource name, used to name an index in a message. */
  readonly name: string;
  readonly state: string;
}

export type Readiness =
  /** Every index is `READY` and has been for the settling period. A report may go out. */
  | { readonly kind: 'ready' }
  /** Every index is `READY`, but not yet for long enough. */
  | { readonly kind: 'settling'; readonly remainingMs: number }
  /** At least one index is still building. Waiting resolves this. */
  | { readonly kind: 'building'; readonly indexes: readonly string[] }
  /** At least one index failed to build. Waiting does not resolve this. */
  | { readonly kind: 'damaged'; readonly indexes: readonly string[] }
  /** A state this version cannot classify. Waiting does not resolve this either. */
  | {
      readonly kind: 'unrecognised';
      readonly indexes: readonly string[];
      readonly states: readonly string[];
    };

/**
 * How long the set must report `READY` before a report is allowed out.
 *
 * **This number is provisional and was not measured.** The transient window is documented by
 * observation — a query failing right after a sibling succeeded — but that observation did not
 * record how long the window lasts, so this is a conservative guess rather than a derived bound.
 * It errs long deliberately: waiting too long costs a slower run, and not waiting long enough costs
 * a false report that §2 forbids and that appears too rarely to be disbelieved.
 */
export const DEFAULT_SETTLE_MS = 60_000;

/**
 * The states this module knows what to *do* with.
 *
 * `STATE_UNSPECIFIED` is deliberately absent: it is a value the API can send and this module can
 * name, but not one it can act on, so it belongs with the states added after this was written. The
 * same line SPEC §7 draws for skip reasons — a value with no published meaning is counted, not
 * guessed at — and here guessing means guessing `READY`.
 */
const ACTIONABLE: ReadonlySet<string> = new Set(['CREATING', 'READY', 'NEEDS_REPAIR']);

/**
 * The names of an observed set, coerced and ordered.
 *
 * `name` gets the same treatment as `state`, and for the same reason: it is declared `string` but
 * arrives from a service, and the generated admin protos type it `string | null`. Left uncoerced it
 * reaches two places that assume otherwise — `compareByCodePoint` calls `Array.from`, which throws
 * on `null`, and `JSON.stringify` maps an `undefined` element to `null`, so a set named `undefined`
 * and a set named `null` would share a fingerprint. Coercing first keeps the declared
 * `readonly string[]` on every verdict honest as well.
 */
function namesOf(indexes: readonly LiveIndex[]): string[] {
  return indexes.map((index) => String(index.name)).sort(compareByCodePoint);
}

/**
 * The identity of an observed set, for detecting that the set itself changed.
 *
 * An index appearing or disappearing is a transition as much as a state change is, and a settling
 * period that survived one would be timing the wrong set.
 *
 * The encoding has to be *injective*, or the check it feeds is worse than useless: two different
 * sets that encode alike would let a period timing the old set be credited to the new one, which
 * is a false `ready` — the one outcome this module exists to prevent. Joining on a separator is
 * not injective unless the separator cannot occur in a name, and `JSON.stringify` is injective
 * over string arrays without needing that assumption to hold.
 */
function fingerprint(indexes: readonly LiveIndex[]): string {
  return JSON.stringify(namesOf(indexes));
}

/**
 * The settling half of the rule, as a state machine over observations.
 *
 * The caller polls the Admin API and hands each result here with a timestamp. Nothing is ready until
 * one observation says every index is `READY` and a later observation, at least `settleMs` after it,
 * says so too — a single observation can never satisfy the gate, which is the point: the failure
 * this guards against is precisely a set that looks ready at one instant.
 */
export class ReadinessGate {
  readonly #settleMs: number;
  /** When the current uninterrupted run of all-`READY` observations began, or `null`. */
  #readySince: number | null = null;
  #seen: string | null = null;

  constructor(settleMs: number = DEFAULT_SETTLE_MS) {
    if (!Number.isFinite(settleMs) || settleMs < 0) {
      throw new RangeError(`settleMs must be a non-negative finite number, got ${settleMs}`);
    }
    this.#settleMs = settleMs;
  }

  /**
   * Classify one observation.
   *
   * `at` must come from a monotonic clock. A wall clock can step backwards, and a settling period
   * measured across a step is not the period that was asked for. A non-finite `at` is rejected for
   * the same reason the constructor rejects a non-finite `settleMs`, and rejecting it *loudly*
   * matters more here: `NaN` would silently anchor the run at `NaN`, every later comparison against
   * it would be false, and the gate would sit in `settling` for the rest of the process — a state
   * `isTransient` reports as worth waiting on, so a polling caller would never stop.
   *
   * An empty set is vacuously all-`READY`, and is reported as such: a database whose candidate set
   * is empty really has nothing left to build. That this is also what a forgotten deploy looks like
   * is a question about whether the set is *present*, which this gate deliberately does not answer —
   * presence needs the candidate declarations, and readiness does not.
   *
   * What the caller must not do is pass `[]` for a listing that *failed* or came back partial. SPEC
   * §3 requires that a principal which cannot list indexes be told readiness could not be
   * established and that `check` decline to report; `[]` here means "observed, and empty", and the
   * gate has no way to tell that apart from "could not observe".
   */
  observe(indexes: readonly LiveIndex[], at: number): Readiness {
    if (!Number.isFinite(at)) {
      throw new RangeError(`at must be a finite number, got ${at}`);
    }

    const unrecognised = indexes.filter((index) => !ACTIONABLE.has(index.state));
    const damaged = indexes.filter((index) => index.state === 'NEEDS_REPAIR');
    const building = indexes.filter((index) => index.state === 'CREATING');

    // Precedence is by what the caller should do next, not by severity. `unrecognised` comes first
    // because it says this version may be misreading the API, which is a reason to distrust the
    // classification of every other index in the same response.
    if (unrecognised.length > 0) {
      this.#reset();
      // Coerced, because `states` is declared `readonly string[]` and the values reaching here are
      // whatever the API sent: the gRPC admin client types `Index.state` as a numeric enum or
      // `null`, and proto3 JSON omits the field entirely when it is `STATE_UNSPECIFIED`. Those all
      // classify as unrecognised either way — coercing only keeps the declared type honest for a
      // caller that builds a message out of it.
      const states = [...new Set(unrecognised.map((index) => String(index.state)))].sort(
        compareByCodePoint,
      );
      return { kind: 'unrecognised', indexes: namesOf(unrecognised), states };
    }
    if (damaged.length > 0) {
      this.#reset();
      return { kind: 'damaged', indexes: namesOf(damaged) };
    }
    if (building.length > 0) {
      this.#reset();
      return { kind: 'building', indexes: namesOf(building) };
    }

    const seen = fingerprint(indexes);
    if (this.#readySince === null || this.#seen !== seen) {
      this.#readySince = at;
      this.#seen = seen;
      // Not `ready`, even at settleMs = 0: the run has to be observed twice to be a run at all.
      return { kind: 'settling', remainingMs: this.#settleMs };
    }

    const elapsed = at - this.#readySince;
    if (elapsed >= this.#settleMs) return { kind: 'ready' };
    return { kind: 'settling', remainingMs: this.#settleMs - elapsed };
  }

  #reset(): void {
    this.#readySince = null;
    this.#seen = null;
  }
}

/** Whether a verdict can change by waiting. `check` should stop rather than poll on `false`. */
export function isTransient(readiness: Readiness): boolean {
  return readiness.kind === 'building' || readiness.kind === 'settling';
}

export function isReportable(readiness: Readiness): boolean {
  return readiness.kind === 'ready';
}
