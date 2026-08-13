/** Control characters: everything below the space, plus DEL. */
const CONTROL = /[\u0000-\u001f\u007f]+/gu;

/**
 * Values read from a linted file — a `collectionGroup`, a `fieldPath`, a direction — may hold any
 * character JSON allows, including a newline, because §4 refuses only what cannot be read as an
 * index declaration at all. `text` renders one finding per line and `github` renders one finding
 * per table row, so a newline in a linted file would otherwise break out of the row and forge a
 * heading or a table of its own in a report the reader is meant to trust.
 *
 * `json` deliberately does not use this: there the value is the contract, and JSON escapes it.
 */
export function oneLine(value: string): string {
  return value.replaceAll(CONTROL, ' ');
}
