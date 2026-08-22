/** Argument parsing, in-tree and without a dependency, in the shape `indexwright` uses. */

import { parseHostPort, requireLoopbackUpstream, type HostOrigin } from './endpoints.js';

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export interface RecordCommand {
  readonly kind: 'record';
  /** `host:port` of the emulator to forward to. */
  readonly emulator: string;
  readonly out: string;
  readonly port: number;
  /** Whether `--allow-remote-emulator` was given, carried through so the proxy sees the same answer. */
  readonly allowRemoteUpstream: boolean;
  /** The command to run with `FIRESTORE_EMULATOR_HOST` pointed at the proxy. */
  readonly argv: readonly string[];
}

export interface CheckCommand {
  readonly kind: 'check';
  /** The project the replay target lives in. Never resolved from the environment — see `parseCheck`. */
  readonly project: string;
  /** The database within it. `(default)` is a name like any other, and has to be written out. */
  readonly database: string;
  /** The corpus to replay, as written by `record`. */
  readonly corpus: string;
  /** The candidate index declarations the target is supposed to be carrying. */
  readonly indexes: string;
}

export type Command = RecordCommand | CheckCommand | { kind: 'help' } | { kind: 'version' };

export const DEFAULT_OUT = 'firestore.queries.json';
export const DEFAULT_EMULATOR = '127.0.0.1:8080';
export const ALLOW_REMOTE_EMULATOR = '--allow-remote-emulator';
export const DEFAULT_CORPUS = DEFAULT_OUT;
export const DEFAULT_INDEXES = 'firestore.indexes.json';

/**
 * The verb, when one is named.
 *
 * `record` is unnamed for compatibility: `indexwright-record -- npm test` is the shape 0.2.0 through
 * 0.4.0 shipped, and the family's other CLI names its verb (`indexwright lint`), so a second verb
 * here arrives as a leading word rather than as a flag. Only the first argument is examined, and
 * only before `--`, so a suite invoked as `-- ./check` is not mistaken for one.
 */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = {}): Command {
  if (argv.length === 0) throw new UsageError('no command given');
  if (argv[0] === 'check') return parseCheck(argv.slice(1));

  // Only before `--`: everything after it belongs to the command being run, and a suite invoked as
  // `-- npm test --help` must not be intercepted here.
  const separator = argv.indexOf('--');
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const rest = separator === -1 ? [] : argv.slice(separator + 1);

  if (options.includes('--help') || options.includes('-h')) return { kind: 'help' };
  if (options.includes('--version')) return { kind: 'version' };

  // Tracked, not just read: the refusal below names where the value came from, and inheriting it
  // from the environment is the case the person running the command may not know about.
  const inherited = env['FIRESTORE_EMULATOR_HOST'];
  let emulator = inherited ?? DEFAULT_EMULATOR;
  let fromFlag = false;
  let out = DEFAULT_OUT;
  let port = 0;
  let allowRemoteUpstream = false;

  for (let i = 0; i < options.length; i += 1) {
    const argument = options[i] as string;
    if (!argument.startsWith('--')) {
      throw new UsageError(`unexpected argument "${argument}"; the command to run goes after "--"`);
    }

    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? null : argument.slice(equals + 1);
    const takeValue = (): string => {
      if (inline !== null) return inline;
      const next = options[i + 1];
      if (next === undefined) throw new UsageError(`${name} needs a value`);
      i += 1;
      return next;
    };

    switch (name) {
      case '--emulator':
        emulator = takeValue();
        fromFlag = true;
        break;
      case ALLOW_REMOTE_EMULATOR:
        // Refused rather than interpreted. `--allow-remote-emulator=false` reads as "off" and would
        // otherwise turn the guard on, because the name is matched with the `=value` already split
        // off — and every value-taking option here accepts that form, so it is one a caller has
        // reason to write. A flag that silently means the opposite of what it says is worse than one
        // that says it takes no value.
        if (inline !== null) throw new UsageError(`${name} takes no value, got "${inline}"`);
        allowRemoteUpstream = true;
        break;
      case '--out':
        out = takeValue();
        break;
      case '--port':
        port = parsePort(takeValue(), name);
        break;
      default:
        throw new UsageError(`unknown option "${name}"`);
    }
  }

  if (rest.length === 0) {
    throw new UsageError('no command to run; pass it after "--", as in: indexwright-record -- npm test');
  }

  // Refused here rather than in `startCapture`, so that nothing is started and the message can say
  // which of the two ways the value arrived. `parseHostPort` is what the proxy will parse it with, so
  // a malformed value is reported as malformed rather than as non-loopback.
  //
  // A UsageError, because exit 2 is what §4's table gives a run that was asked for wrongly, and the
  // fix is on the command line either way — correct the upstream, or state the intent.
  const origin: HostOrigin = fromFlag
    ? { kind: 'flag', option: '--emulator' }
    : { kind: 'env', variable: 'FIRESTORE_EMULATOR_HOST' };
  const upstream = readUpstreamHost(emulator, origin);
  try {
    requireLoopbackUpstream({
      host: upstream,
      value: emulator,
      origin,
      override: ALLOW_REMOTE_EMULATOR,
      allowed: allowRemoteUpstream,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  return { kind: 'record', emulator, out, port, allowRemoteUpstream, argv: rest };
}

/**
 * `check`'s arguments, with the replay target named outright.
 *
 * The target is two required flags and has no default, no environment fallback, and no inference
 * from the credentials in use (issue #8). `GOOGLE_CLOUD_PROJECT`, a `gcloud config` default, and the
 * project inside application default credentials all resolve to whatever the person running this
 * last worked against, which for anyone who has recently touched a real environment is a database
 * carrying a full index set. Replaying against one of those does not fail loudly; it returns a clean
 * report, because a database holding more indexes than the candidate set serves queries the
 * candidate set alone would not. Credentials still come from ADC — that is how a runner is
 * credentialed, and SPEC §3 relies on it. What may not come from ambient state is *which database*
 * is measured.
 *
 * Two flags rather than one `projects/…/databases/…` because the refusal can then name the half that
 * is missing, and because Firestore's default database is literally called `(default)` — a value a
 * shell needs quoted, which is easier to get right as a short argument of its own.
 */
function parseCheck(options: readonly string[]): Command {
  let project: string | undefined;
  let database: string | undefined;
  let corpus = DEFAULT_CORPUS;
  let indexes = DEFAULT_INDEXES;

  for (let i = 0; i < options.length; i += 1) {
    const argument = options[i] as string;
    // Answered inside the loop rather than by a scan over every token, so that a `--help` or a
    // `--version` sitting where a value belongs is the missing value it actually is. Scanned ahead,
    // `check --database --version` printed the version and exited 0 — a success for a command line
    // that named no database. `-h` is taken here too, since it is the one argument this verb accepts
    // that does not begin with `--`.
    if (argument === '-h' || argument === '--help') return { kind: 'help' };
    // Both are questions about the binary rather than about the verb, and a `--version` that works
    // only while no verb is named stops working the moment a wrapper script starts naming one.
    if (argument === '--version') return { kind: 'version' };
    if (!argument.startsWith('--')) throw new UsageError(`unexpected argument "${argument}"`);

    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? null : argument.slice(equals + 1);
    const takeValue = (): string => {
      if (inline !== null) return inline;
      const next = options[i + 1];
      if (next === undefined) throw new UsageError(`${name} needs a value`);
      i += 1;
      return next;
    };

    switch (name) {
      case '--project':
        project = requireSegment(takeValue(), name);
        break;
      case '--database':
        database = requireSegment(takeValue(), name);
        break;
      case '--corpus':
        corpus = requirePath(takeValue(), name);
        break;
      case '--indexes':
        indexes = requirePath(takeValue(), name);
        break;
      default:
        throw new UsageError(`unknown option "${name}"`);
    }
  }

  // Named separately rather than as "the target is incomplete", because the two are supplied from
  // different places often enough — a project from a deploy script, a database written by hand —
  // that saying which one is absent is the difference between a fix and a re-read of the usage.
  if (project === undefined) throw new UsageError('--project is required; check does not infer the target');
  if (database === undefined) throw new UsageError('--database is required; the default database is named "(default)"');

  return { kind: 'check', project, database, corpus, indexes };
}

/**
 * A project id or database name that will still mean itself inside a resource path.
 *
 * Refused rather than escaped: `projects/{project}/databases/{database}` is built from these, so a
 * value carrying a slash addresses a different resource than the one written on the command line,
 * and an empty one addresses the collection rather than a member of it. Both are cases where the
 * target echoed back would not be the target measured, which is the whole point of naming it.
 *
 * An allowlist, arrived at the hard way. The question a segment has to answer is not "is this a
 * legal Firestore id" but "does this still name what it appears to name once a URL layer has seen
 * it" — and refusing the ways it can fail one at a time does not converge. A slash retargets; so
 * does a backslash, which the WHATWG URL parser folds into a slash before resolving dot segments,
 * so `throwaway\..\prod` echoes as itself and requests `prod`. `.` and `..` collapse on their own.
 * `?` and `#` end the path and begin a query or a fragment. `%2e%2e` arrives already decoded.
 *
 * And because `cli.ts` prints this path as the one line an operator is asked to trust, anything that
 * can forge a line of it counts as the same failure: a newline writes a second well-formed
 * `indexwright-record:` line beside the real one naming a database nobody targeted, a carriage
 * return or an escape sequence overwrites the real one in place, U+0085 and U+2028 are line breaks
 * to plenty of viewers — and `JSON.stringify` escapes neither — while the bidi overrides reorder a
 * name without altering a character of it.
 *
 * So the test is inverted. What survives is strictly *wider* than Google's rules for either half —
 * both are lowercase alphanumerics and hyphens, plus the literal `(default)` — which is the property
 * the refusal-by-refusal version was trying to buy: a validator that is merely close refuses valid
 * targets, and for a required argument with no fallback that leaves no way to proceed. Being
 * deliberately looser than the real rules keeps that, and makes the answer to "what else gets
 * through" be nothing rather than a list that was short by one every time it was read.
 */
const SEGMENT = /^[A-Za-z0-9_.()-]+$/;

function requireSegment(value: string, option: string): string {
  const shown = render(value);
  if (value === '') throw new UsageError(`${option} needs a value`);
  // Not a malformed name but a missing one: the next option, absorbed because the one before it was
  // written without its argument. No id may begin with `-`, so this cannot be a real target.
  if (value.startsWith('-')) throw new UsageError(`${option} needs a value, got the option ${shown}`);
  if (value === '.' || value === '..') throw new UsageError(`${option} cannot be ${shown}`);
  if (!SEGMENT.test(value)) {
    throw new UsageError(
      `${option} may hold only letters, digits, "-", "_", ".", and parentheses, got ${shown}`,
    );
  }
  return value;
}

/**
 * A value written back into a message safely, which `JSON.stringify` alone does not do.
 *
 * It leaves U+0085 and U+2028 raw, and these messages go to the same stream the target is announced
 * on — so a refusal naming a value that forges a line would forge one itself. Everything outside
 * printable ASCII is escaped rather than emitted.
 */
function render(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"' || character === '\\') out += `\\${character}`;
    else if (code >= 0x20 && code <= 0x7e) out += character;
    else out += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return `"${out}"`;
}

/**
 * A file path, checked only for having been written at all.
 *
 * Unlike a target segment, what is *in* it is the filesystem's business rather than this parser's —
 * but an empty one is not a path, and `resolve('')` is the working directory, so a `--corpus=` typed
 * with nothing after it would otherwise be read as a request to open a directory as a corpus.
 *
 * A leading `-` is refused for the same reason it is on a target segment: `--corpus --indexes` is a
 * missing value rather than a file named `--indexes`, and read as a filename it fails much later,
 * somewhere that can no longer say which option was written without its argument. A path that really
 * does begin with `-` is still reachable as `./-name`.
 */
function requirePath(value: string, option: string): string {
  if (value === '') throw new UsageError(`${option} needs a value`);
  if (value.startsWith('-')) {
    throw new UsageError(`${option} needs a value, got the option ${render(value)}`);
  }
  return value;
}

/** `projects/{project}/databases/{database}`, the form the Admin API and a report both name it in. */
export function canonicalTarget(command: Pick<CheckCommand, 'project' | 'database'>): string {
  return `projects/${command.project}/databases/${command.database}`;
}

/**
 * The host half of an emulator address, or a usage error naming what was wrong with it.
 *
 * The proxy parses the same string with the same function, so a value this accepts is one it will
 * accept too. Rewrapped as a `UsageError` because a malformed address is a usage error, and it has to
 * be reported as malformed rather than reaching the loopback check and being refused as "not
 * loopback" — which would be true, and useless.
 *
 * Named by origin for the same reason the refusal below is: an address inherited from the
 * environment is not one the reader can find on their command line, so blaming `--emulator` for it
 * sends them to look at a flag they never passed.
 */
function readUpstreamHost(value: string, origin: HostOrigin): string {
  try {
    return parseHostPort(value).host;
  } catch (error) {
    const source =
      origin.kind === 'flag' ? origin.option : origin.kind === 'env' ? origin.variable : origin.field;
    throw new UsageError(`${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 0 means "let the OS choose", which is the default and the reason this is not a positive integer. */
function parsePort(value: string, option: string): number {
  if (!/^\d+$/.test(value)) throw new UsageError(`${option} needs a port number, got "${value}"`);
  const port = Number(value);
  if (port > 65535) throw new UsageError(`${option} needs a port number, got "${value}"`);
  return port;
}

export function usage(): string {
  return [
    'indexwright-record [options] -- <command> [args...]',
    'indexwright-record check --project <id> --database <name> [options]',
    '',
    'Runs <command> with FIRESTORE_EMULATOR_HOST pointed at a capture proxy in front of the',
    'Firestore emulator, and writes the query shapes it observed as a corpus.',
    '',
    'The corpus records shape only — collection, scope, filters, sort order. Values, project and',
    'database, limits, cursors, and occurrence counts are not recorded.',
    '',
    'Options:',
    `  --emulator <host:port>  the emulator to forward to (default: $FIRESTORE_EMULATOR_HOST, else ${DEFAULT_EMULATOR})`,
    `  --out <file>            where to write the corpus (default: ${DEFAULT_OUT})`,
    '  --port <n>              port for the proxy to listen on (default: chosen by the OS)',
    `  ${ALLOW_REMOTE_EMULATOR}`,
    '                          forward to an emulator that is not on this host. Refused by default:',
    '                          the proxy authenticates nothing and forwards verbatim, so a wrong',
    '                          upstream routes real documents and credentials through this process',
    '  -h, --help              show this message',
    '      --version           show the version',
    '',
    'The proxy always listens on loopback. There is no option to change that.',
    '',
    'check replays a corpus against a database that already has the candidate index set applied,',
    'and reports the queries it cannot serve. It applies nothing and reads only.',
    '',
    'Replay is not implemented yet: check parses and echoes its target, then exits 2.',
    '',
    'Options:',
    '  --project <id>          project holding the database to replay against (required)',
    '  --database <name>       database within it (required; the default one is named "(default)")',
    `  --corpus <file>         the corpus to replay (default: ${DEFAULT_CORPUS})`,
    `  --indexes <file>        the candidate index declarations (default: ${DEFAULT_INDEXES})`,
    '',
    'The target is never inferred. GOOGLE_CLOUD_PROJECT, gcloud config, and the project inside',
    'application default credentials are not consulted for it: a database carrying more indexes',
    'than the candidate set answers queries the candidate set alone would not, so the wrong target',
    'returns a clean report rather than an error. Credentials still come from ADC.',
    '',
    'Exit codes:',
    '  the exit code of <command>, so a failing suite still fails',
    '  2  usage error, or the corpus could not be written',
    '     check also exits 2 until replay is implemented, on an otherwise valid command line',
  ].join('\n');
}
