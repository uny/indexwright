/** Argument parsing, in-tree and without a dependency, in the shape `indexwright` uses. */

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export interface RecordCommand {
  readonly kind: 'record';
  /** `host:port` of the emulator to forward to. */
  readonly emulator: string;
  readonly out: string;
  readonly port: number;
  /** The command to run with `FIRESTORE_EMULATOR_HOST` pointed at the proxy. */
  readonly argv: readonly string[];
}

export type Command = RecordCommand | { kind: 'help' } | { kind: 'version' };

export const DEFAULT_OUT = 'firestore.queries.json';
export const DEFAULT_EMULATOR = '127.0.0.1:8080';

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = {}): Command {
  if (argv.length === 0) throw new UsageError('no command given');

  // Only before `--`: everything after it belongs to the command being run, and a suite invoked as
  // `-- npm test --help` must not be intercepted here.
  const separator = argv.indexOf('--');
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const rest = separator === -1 ? [] : argv.slice(separator + 1);

  if (options.includes('--help') || options.includes('-h')) return { kind: 'help' };
  if (options.includes('--version')) return { kind: 'version' };

  let emulator = env['FIRESTORE_EMULATOR_HOST'] ?? DEFAULT_EMULATOR;
  let out = DEFAULT_OUT;
  let port = 0;

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

  return { kind: 'record', emulator, out, port, argv: rest };
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
    '  -h, --help              show this message',
    '      --version           show the version',
    '',
    'Exit codes:',
    '  the exit code of <command>, so a failing suite still fails',
    '  2  usage error, or the corpus could not be written',
  ].join('\n');
}
