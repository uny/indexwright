/**
 * Turning the rows a differential run produced into findings, an exit code, and the lines an
 * operator reads.
 *
 * Separated from issuing the queries for the reason `buildReplayQuery` is separated from running
 * one: this is where the run stops being a list of answers and becomes a verdict, and it is the half
 * that can be tested without a database. It had never been executed at all — the instrument's own
 * stop rule was asserted rather than checked, which is the defect it exists to close.
 *
 * Pure: no client, no environment, no clock. Everything it needs arrives as arguments.
 */

/** Only these two verdicts are statements about the index set, so only these two are compared. */
const COMPARABLE = new Set(['served', 'uncovered']);

/**
 * Neither expected nor deterministic, unlike `invalid`.
 *
 * `invalid` is the backend refusing an operand it was always going to refuse — an `array-contains`
 * against a map — so it drops out of the comparison and is reported in the count. These two are a
 * gRPC status this script could not interpret, and the SDK refusing to build the query at all.
 * Either shrinks the evidence for a shape while the shape still reads `constant`.
 */
const UNRELIABLE = new Set(['other', 'unbuildable']);

/**
 * @param results rows as `differential.mjs` collected them: `{shape, variant, verdict, ...}`
 * @param shapes the shape definitions, in report order
 * @param expected a Map of shape id to the verdict the runbook predicted, or an empty Map
 */
export function summarise(results, shapes, expected = new Map()) {
  // Derived from `results` rather than counted while issuing: every applied variant pushes exactly
  // one row there, including the ones that threw while building, so this cannot fall out of step
  // with what was run the way a second counter could.
  const issued = new Map();
  for (const row of results) issued.set(row.shape, (issued.get(row.shape) ?? 0) + 1);

  const findings = [];
  for (const shape of shapes) {
    const answered = results.filter((r) => r.shape === shape.id && COMPARABLE.has(r.verdict));
    const verdicts = new Set(answered.map((r) => r.verdict));
    if (shape.varies === 'nothing') {
      // For a shape whose filters are *all* unary, and no shape currently is: there would then be
      // nothing about it for a value to change, and counting it as untested would report a hole
      // where the question does not arise.
      findings.push({ shape: shape.id, kind: 'not-applicable', verdict: [...verdicts][0] ?? 'none' });
    } else if (answered.length < 2) {
      findings.push({ shape: shape.id, kind: 'untested', reached: answered.length });
    } else if (verdicts.size > 1) {
      findings.push({
        shape: shape.id,
        kind: 'claim-falsified',
        byVariant: Object.fromEntries(answered.map((r) => [r.variant, r.verdict])),
      });
    } else {
      findings.push({
        shape: shape.id,
        kind: 'constant',
        verdict: [...verdicts][0],
        variants: answered.length,
        // Beside the count that entered the comparison, because the two differing is the whole of
        // the fourth stop condition: `constant across 2 operands` reads like a verdict over the
        // shape and says nothing about the rows dropped before the comparison ran.
        issued: issued.get(shape.id) ?? 0,
      });
    }
  }

  const unreliable = results.filter((r) => UNRELIABLE.has(r.verdict));

  // Only `constant` shapes are checked against an expectation: a falsified or untested shape has
  // already failed on its own terms, and reporting it again as "against expectation" would bury the
  // finding that matters under a consequence of it.
  const unexpected = [];
  for (const finding of findings) {
    const want = expected.get(finding.shape);
    if (want === undefined || finding.kind !== 'constant') continue;
    if (finding.verdict !== want) {
      unexpected.push({ shape: finding.shape, expected: want, actual: finding.verdict });
    }
  }

  const falsified = findings.filter((f) => f.kind === 'claim-falsified');
  const untested = findings.filter((f) => f.kind === 'untested');

  // 1 is a finding: the claim did not survive. 2 is "could not answer", and takes precedence — the
  // contract `check` keeps, and the reason both new conditions are 2 rather than 1. An operand that
  // could not be issued leaves a shape measured over fewer operands than the run believes, and a
  // shape answering against a supplied expectation means the target is not the one the runbook
  // described: a bare target that serves S1 was not bare, and every reading taken from it is of some
  // other index set. Neither is a verdict about SPEC §7. Both used to print a line and exit 0.
  let exitCode = 0;
  if (untested.length > 0 || unreliable.length > 0 || unexpected.length > 0) exitCode = 2;
  else if (falsified.length > 0) exitCode = 1;

  return { findings, unreliable, unexpected, falsified, untested, exitCode };
}

/** The summary lines, in report order. Returned rather than written, so a test can read them. */
export function summaryLines({ findings, unreliable, unexpected }) {
  const lines = [];
  for (const finding of findings) {
    if (finding.kind === 'constant') {
      // `N of M`, always, even when equal. A bare `constant across 2 operands` gives a reader
      // nothing to compare 2 against, and the comparison is the point.
      const short = finding.variants < finding.issued ? ' — SHORT' : '';
      lines.push(
        `${finding.shape} constant across ${finding.variants} of ${finding.issued} operands: ` +
          `${finding.verdict}${short}`,
      );
    } else if (finding.kind === 'not-applicable') {
      lines.push(`${finding.shape} has no operand to vary; answered ${finding.verdict}`);
    } else if (finding.kind === 'untested') {
      lines.push(`${finding.shape} UNTESTED — only ${finding.reached} operand reached the backend`);
    } else {
      lines.push(`${finding.shape} FALSIFIES SPEC §7: ${JSON.stringify(finding.byVariant)}`);
    }
  }
  for (const row of unreliable) {
    lines.push(
      `${row.shape} ${row.variant} answered ${row.verdict.toUpperCase()}, so it did not enter the ` +
        `comparison: ${row.message}`,
    );
  }
  for (const row of unexpected) {
    lines.push(`${row.shape} AGAINST EXPECTATION — expected ${row.expected}, answered ${row.actual}`);
  }
  return lines;
}
