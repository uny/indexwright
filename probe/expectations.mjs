/**
 * The command line of `differential.mjs`, parsed away from the client it constructs.
 *
 * Separated for the reason `summarise.mjs` is: this is gate logic, and gate logic that has never
 * been executed is a claim rather than a mechanism. It could not be executed where it was —
 * top-level statements in a module that builds a `Firestore` on import and calls `process.exit` on
 * every refusal — so nothing connected the string the runbook tells an operator to type to the Map
 * the stop rule consumes. `packages/record/src/args.ts` reaches the same conclusion for the same
 * reason and in the same shape: parse purely, throw `UsageError`, and let the caller decide that a
 * usage error means exit 2.
 *
 * Pure: no client, no environment, no `process`. Everything it needs arrives as arguments.
 */

/** Thrown for anything the caller should print as usage and exit 2 on. */
export class UsageError extends Error {
  name = 'UsageError';
}

const FLAGS = new Map([
  ['--expect-uncovered', 'uncovered'],
  ['--expect-served', 'served'],
]);

/**
 * @param argv `process.argv.slice(2)`
 * @param shapeIds every known shape id, for refusing an expectation that could never fail
 * @returns `{ positional, expected }` — expectations by shape id; absent means unconstrained
 */
export function parseExpectations(argv, shapeIds) {
  const positional = [];
  const expected = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const verdict = FLAGS.get(arg);
    if (verdict === undefined) {
      // A flag this script does not define is refused rather than taken as the project. A typo'd
      // `--expect-uncoverd` read as a positional would name a project that does not exist, which is
      // a clearer failure than the one below it — but a *third* positional would be silently
      // ignored, and that is how an expectation goes unenforced while the run reports having
      // enforced it.
      if (arg.startsWith('-')) throw new UsageError(`${arg} is not an option this script defines`);
      positional.push(arg);
      continue;
    }
    const list = argv[i + 1];
    if (list === undefined || list.startsWith('-')) {
      throw new UsageError(`${arg} needs a comma-separated list of shape ids`);
    }
    i += 1;
    const ids = list.split(',').map((value) => value.trim()).filter((value) => value !== '');
    // An empty list was the one way of getting these flags wrong that was accepted. It is the way
    // that actually happens: the runbook's invocation spans three lines, and wrapped in a script as
    // `--expect-uncovered "$EXPECT_UNCOVERED"` an unset variable expands to exactly this. The run
    // then enforced nothing, exited 0, and reported `"expected": {}` — which reads as "checked,
    // nothing violated" rather than "never checked", on the one step whose whole job is to stop a
    // deploy.
    if (ids.length === 0) throw new UsageError(`${arg} was given an empty list of shape ids`);
    for (const id of ids) {
      // Refused rather than dropped, for the reason `suite.mjs` refuses an unknown PROBE_SHAPES id:
      // the ids are retyped by hand from the runbook, and an expectation naming a shape that does
      // not exist is an expectation that can never fail — the run then reports a stop rule it never
      // ran.
      if (!shapeIds.includes(id)) {
        throw new UsageError(`${arg} names ${id}, which is not a shape — known ids are ${shapeIds.join(', ')}`);
      }
      // A shape named by both flags cannot be satisfied, and taking the last one silently would let
      // a copy-paste between the two runbook steps enforce the opposite of what was written.
      const already = expected.get(id);
      if (already !== undefined && already !== verdict) {
        throw new UsageError(`${id} is expected both served and uncovered`);
      }
      expected.set(id, verdict);
    }
  }

  if (positional.length > 2) throw new UsageError(`unexpected argument ${positional[2]}`);
  if (positional.length === 0) throw new UsageError('a project is required');

  return { positional, expected };
}
