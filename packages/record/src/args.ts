/** Argument parsing, in-tree and without a dependency, in the shape `indexwright` uses. */

import { parseHostPort, requireLoopbackUpstream } from './endpoints.js';

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

export type Command = RecordCommand | { kind: 'help' } | { kind: 'version' };

export const DEFAULT_OUT = 'firestore.queries.json';
export const DEFAULT_EMULATOR = '127.0.0.1:8080';
export const ALLOW_REMOTE_EMULATOR = '--allow-remote-emulator';

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = {}): Command {
  if (argv.length === 0) throw new UsageError('no command given');

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
  const upstream = readUpstreamHost(emulator);
  try {
    requireLoopbackUpstream({
      host: upstream,
      value: emulator,
      origin: fromFlag
        ? { kind: 'flag', option: '--emulator' }
        : { kind: 'env', variable: 'FIRESTORE_EMULATOR_HOST' },
      override: ALLOW_REMOTE_EMULATOR,
      allowed: allowRemoteUpstream,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  return { kind: 'record', emulator, out, port, allowRemoteUpstream, argv: rest };
}

/**
 * The host half of an `--emulator` value, or a usage error naming what was wrong with it.
 *
 * The proxy parses the same string with the same function, so a value this accepts is one it will
 * accept too. Rewrapped as a `UsageError` because a malformed address is a usage error, and it has to
 * be reported as malformed rather than reaching the loopback check and being refused as "not
 * loopback" — which would be true, and useless.
 */
function readUpstreamHost(value: string): string {
  try {
    return parseHostPort(value).host;
  } catch (error) {
    throw new UsageError(`--emulator: ${error instanceof Error ? error.message : String(error)}`);
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
    'Exit codes:',
    '  the exit code of <command>, so a failing suite still fails',
    '  2  usage error, or the corpus could not be written',
  ].join('\n');
}
