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
      onWarning: (message) => streams.err(`indexwright-record: ${message}\n`),
    });
  } catch (error) {
    streams.err(`indexwright-record: could not start the capture proxy: ${(error as Error).message}\n`);
    return 2;
  }

  let status: number;
  try {
    status = await runChild(command.argv, { ...env, FIRESTORE_EMULATOR_HOST: capture.address });
  } catch (error) {
    // A command that cannot be started is the user's typo, not a crash to show a stack trace for.
    // No corpus is written: nothing ran, so there is nothing this run is evidence of.
    streams.err(`indexwright-record: could not run ${command.argv.join(' ')}: ${(error as Error).message}\n`);
    return 2;
  } finally {
    await capture.close();
  }

  // Written whatever the suite's verdict was: a query that failed still describes something the
  // application issues, and a query that failed for want of an index is the interesting case.
  const out = resolve(command.out);
  try {
    writeCorpus(out, buildCorpus(capture.recorder.shapes, capture.recorder.skips.keys()));
  } catch (error) {
    streams.err(`indexwright-record: could not write ${out}: ${(error as Error).message}\n`);
    return 2;
  }

  report(capture.recorder, command.out, streams);
  return status;
}

function report(recorder: Recorder, out: string, streams: Streams): void {
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

function runChild(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command, ...args] = argv as [string, ...string[]];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      // The shell convention, so that a suite killed by a signal is not reported as a clean run.
      resolvePromise(signal === null ? (code ?? 0) : 128 + signalNumber(signal));
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
