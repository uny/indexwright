#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs, usage, UsageError } from './args.js';
import { buildCorpus, writeCorpus } from './corpus.js';
import { startCapture } from './proxy.js';
import type { Recorder } from './recorder.js';
import { compareByCodePoint } from './shape.js';
import { VERSION } from './version.js';

export interface Streams {
  out(text: string): void;
  err(text: string): void;
}

export async function run(
  argv: readonly string[],
  streams: Streams,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let command;
  try {
    command = parseArgs(argv, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    streams.err(`indexwright-record: ${error.message}\n\n${usage()}\n`);
    return 2;
  }

  if (command.kind === 'help') {
    streams.out(`${usage()}\n`);
    return 0;
  }
  if (command.kind === 'version') {
    streams.out(`${VERSION}\n`);
    return 0;
  }

  let capture;
  try {
    capture = await startCapture({
      upstream: command.emulator,
      port: command.port,
      // `parseArgs` has already refused a non-loopback upstream unless this was asked for, so the
      // check inside `startCapture` cannot fire here. Passed anyway rather than relied on: the two
      // must not be able to disagree about what was permitted, and a future caller that reaches
      // `startCapture` by another route gets the same answer. There is no bind counterpart — the
      // verb has no `--host`, so the proxy's loopback default is the only address it ever binds.
      allowRemoteUpstream: command.allowRemoteUpstream,
      onWarning: (message) => streams.err(`indexwright-record: ${message}\n`),
    });
  } catch (error) {
    streams.err(`indexwright-record: could not start the capture proxy: ${(error as Error).message}\n`);
    return 2;
  }

  let outcome: ChildResult;
  try {
    outcome = await runChild(command.argv, { ...env, FIRESTORE_EMULATOR_HOST: capture.address });
  } catch (error) {
    // A command that cannot be started is the user's typo, not a crash to show a stack trace for.
    // No corpus is written: nothing ran, so there is nothing this run is evidence of.
    streams.err(`indexwright-record: could not run ${command.argv.join(' ')}: ${(error as Error).message}\n`);
    return 2;
  } finally {
    await capture.close();
  }

  // Written whatever the suite's verdict was: a query that failed still describes something the
  // application issues, and the emulator does not enforce composite indexes, so a run that passes
  // here says nothing about whether the queries it issued are indexed. That is what the corpus is
  // for, and dropping it on a red suite would drop the queries a fix has to keep working. An
  // interrupted run reaches here for the same reason — see `runChild`.
  const out = resolve(command.out);
  try {
    writeCorpus(out, buildCorpus(capture.recorder.shapes, capture.recorder.skips.keys()));
  } catch (error) {
    streams.err(`indexwright-record: could not write ${out}: ${(error as Error).message}\n`);
    return 2;
  }

  report(capture.recorder, command.out, streams, outcome.interrupted);
  return outcome.status;
}

function report(
  recorder: Recorder,
  out: string,
  streams: Streams,
  interrupted: NodeJS.Signals | undefined,
): void {
  if (interrupted !== undefined) {
    // Said before the counts, because it is why they are as low as they are. Someone who has just
    // pressed Ctrl-C on a long suite has every reason to assume the run was lost, and the corpus
    // being on disk anyway is the whole of this behaviour.
    streams.err(
      `indexwright-record: interrupted by ${interrupted}; the corpus holds what was observed ` +
        'up to that point\n',
    );
  }

  const distinct = recorder.shapes.length;
  streams.err(
    `indexwright-record: ${recorder.observed} query request(s) observed, ` +
      `${distinct} distinct shape(s) written to ${out}\n`,
  );

  if (recorder.skips.size > 0) {
    const counts = [...recorder.skips.entries()]
      .sort(([a], [b]) => compareByCodePoint(a, b))
      .map(([reason, count]) => `${count} ${reason}`)
      .join(', ');
    streams.err(`indexwright-record: not recorded: ${counts}\n`);
  }

  if (recorder.http1 > 0) {
    // Not a corpus skip reason: HTTP/1.1 carries no gRPC, so this is the transport gap rather than
    // a query the proxy declined. Saying so is the difference between a narrow corpus and one that
    // looks complete.
    streams.err(
      `indexwright-record: ${recorder.http1} request(s) arrived over HTTP/1.1 (REST or WebChannel) ` +
        'and carry no gRPC to capture; queries issued that way are absent from the corpus\n',
    );
  }
}

interface ChildResult {
  readonly status: number;
  /**
   * The signal this process was asked to stop on, when it was.
   *
   * Not the same question as which signal the child died from. A suite that traps `SIGINT` and exits
   * on its own terms leaves this set and `close`'s signal null, and a suite killed by something
   * nobody sent to the recorder leaves the opposite.
   */
  readonly interrupted?: NodeJS.Signals;
}

/**
 * The signals an interrupted run arrives as.
 *
 * `SIGINT` is Ctrl-C and `SIGTERM` is what a CI runner or a supervisor sends when it wants the job
 * to stop. Every other signal keeps Node's default: `SIGKILL` cannot be handled at all, and a
 * recorder that survived `SIGQUIT` or `SIGHUP` in order to finish writing would be disobeying the
 * one instruction those carry.
 */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * Run the suite, staying alive through an interrupt for long enough to keep what was captured.
 *
 * Ctrl-C reaches the whole foreground process group, so the child gets its own copy and this process
 * gets one too — and Node's default terminates it on the spot, before the capture is closed and
 * before the corpus is written (issue #10). Everything observed up to that moment is discarded,
 * which on a long suite is the entire point of the run, and interrupting a long suite is exactly
 * when someone does it.
 *
 * Handling the signal here keeps the ordinary exit path rather than adding a second one: the child
 * is *signalled* rather than killed, so its own cleanup runs, and then awaited, so `run` closes the
 * capture and writes the corpus the same way it does for a suite that exited by itself.
 *
 * The handlers live only for as long as the child does. Before that nothing has been observed, and
 * after it the corpus is already on disk, so in both windows the default is what should happen.
 */
function runChild(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<ChildResult> {
  const [command, ...args] = argv as [string, ...string[]];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    let interrupted: NodeJS.Signals | undefined;

    const installed = new Map<NodeJS.Signals, () => void>();
    const release = (): void => {
      for (const [signal, handler] of installed) process.off(signal, handler);
      // Not merely tidiness: a registered signal listener holds a ref'd handle that keeps the event
      // loop alive, so leaving one behind would hang the recorder after a run it completed.
      installed.clear();
    };

    for (const signal of FORWARDED_SIGNALS) {
      const handler = (): void => {
        // Released on the first signal, so a second Ctrl-C meets Node's default and kills at once.
        // Pressing it again is a request not to wait, and a suite that ignores the signal would
        // otherwise hold the recorder open for as long as it liked.
        release();
        interrupted = signal;
        child.kill(signal);
      };
      installed.set(signal, handler);
      process.on(signal, handler);
    }

    child.on('error', (error) => {
      release();
      reject(error);
    });
    child.on('close', (code, signal) => {
      release();
      // What ended this run was the interrupt, whatever the child made of it. A suite that traps
      // `SIGINT` and exits 0 did not turn an interrupted run into a successful one, and the exit
      // code is what a shell loop or a CI step branches on.
      if (interrupted !== undefined) {
        resolvePromise({ status: 128 + signalNumber(interrupted), interrupted });
        return;
      }
      // The shell convention, so that a suite killed by a signal is not reported as a clean run.
      resolvePromise({ status: signal === null ? (code ?? 0) : 128 + signalNumber(signal) });
    });
  });
}

/** The signals a test run plausibly dies from. Anything else is reported as a terminate. */
const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

function signalNumber(signal: NodeJS.Signals): number {
  return SIGNAL_NUMBERS[signal] ?? 15;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await run(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
