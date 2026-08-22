#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, openSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { canonicalTarget, parseArgs, usage, UsageError } from './args.js';
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

  if (command.kind === 'check') {
    // Said before anything else happens, and on every run rather than only on a failure. It is the
    // one thing about a `check` run that cannot be recovered from the output afterwards, and the
    // mistake it guards against — a target that is real rather than throwaway — is silent by
    // construction (issue #8). A statement of fact, not a judgement: nothing here inspects the name
    // for how production-like it looks, because a rule that fires on `prod-sandbox` and stays quiet
    // on `db-7` teaches its own silence to be read as an all-clear.
    streams.err(`indexwright-record: target ${canonicalTarget(command)}\n`);
    streams.err('indexwright-record: check is not implemented yet\n');
    return 2;
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

  // The outer `finally` is what makes `release` unconditional. Every way out of the rest of this
  // function has to reach it — including one that leaves through `capture.close()` — because a
  // signal listener left installed refs the event loop and hangs a run that is otherwise over.
  let outcome: ChildResult | undefined;
  try {
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
  } finally {
    // Undefined only when the child never started, which released on its own way out.
    outcome?.release();
  }
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
  /**
   * Remove the interrupt handlers, which outlive the suite on purpose.
   *
   * Idempotent, and the caller must call it: a registered signal listener holds a ref'd handle that
   * keeps the event loop alive, so one left behind hangs the recorder after a run it completed.
   */
  readonly release: () => void;
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
 * Whether this process has to pass a signal on, or the suite already has its own copy.
 *
 * A terminal sends `SIGINT` to the whole foreground process group, and the suite is in this process
 * group: it is spawned without `detached`, deliberately, so that a recorder killed outright cannot
 * leave the suite running somewhere nothing will signal it. On a terminal the suite therefore has
 * the signal already, and handing it a second one is not a harmless duplicate — `vitest`, `mocha`
 * and others read a repeated interrupt as "stop waiting and quit", which skips exactly the cleanup
 * this handling exists to let them finish. Forwarding unconditionally would make Ctrl-C behave worse
 * under `indexwright-record` than without it, and the whole design of this proxy is to be something
 * a suite cannot tell it is running under.
 *
 * `SIGTERM` is passed on unconditionally, which is a weaker claim than it looks. No terminal
 * generates one, but a process manager may still deliver it to the whole group — systemd's default
 * `KillMode=control-group` does — and the suite then gets a duplicate here. It is forwarded anyway,
 * because declining would lose what a `SIGTERM` usually is: one aimed at this process alone, by a
 * supervisor or a container runtime, which nothing else will pass on. Nothing at delivery time tells
 * the two apart, and of the two mistakes this is the recoverable one.
 *
 * For `SIGINT` the test is whether a terminal is attached at all, which is as close as this gets:
 * once a signal has arrived, nothing distinguishes a tty-generated one from a targeted one. So it
 * errs toward not sending a duplicate. The cost of being wrong that way is a `kill -INT` aimed at a
 * recorder that happens to be on a tty: the suite is never signalled and the run waits on it, and
 * the second signal — the handlers being gone by then — ends the recorder rather than the suite,
 * leaving the suite to be stopped by hand. Against that, the cost of being wrong the other way is
 * every ordinary Ctrl-C cutting a suite's cleanup short.
 */
export function shouldForward(signal: NodeJS.Signals, terminalAttached: boolean): boolean {
  return signal !== 'SIGINT' || !terminalAttached;
}

/**
 * Whether this process has a terminal, which is what decides who else a `SIGINT` reached.
 *
 * `isTTY` alone answers a narrower question than the one being asked — whether a given *stream* is a
 * terminal — and a redirected run still has one. `indexwright-record -- npm test </dev/null >run.log
 * 2>&1` from a shell keeps its controlling terminal and its place in the foreground process group,
 * so Ctrl-C reaches the suite, yet all three streams are pipes and `isTTY` says no terminal. The
 * suite was then handed the duplicate this rule exists to withhold. Opening `/dev/tty` asks whether
 * this process has a controlling terminal at all, which is the question, and redirection does not
 * change the answer. The stream test stays in front of it because Windows has no `/dev/tty`.
 */
function terminalAttached(): boolean {
  if (
    process.stdin.isTTY === true ||
    process.stdout.isTTY === true ||
    process.stderr.isTTY === true
  ) {
    return true;
  }
  try {
    closeSync(openSync('/dev/tty', 'r'));
    return true;
  } catch {
    return false;
  }
}

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
 * is awaited so its own cleanup runs, and `run` then closes the capture and writes the corpus the
 * same way it does for a suite that exited by itself. It is *signalled* rather than killed, and only
 * when the signal did not already reach it — see `shouldForward`.
 *
 * The handlers go up with the child, and on a run nothing interrupts they come down only once `run`
 * has written the corpus — not the moment the suite exits. Closing the capture and writing the
 * corpus is the stretch this change exists to protect, and the suite having exited protects none of
 * it: a Ctrl-C landing a millisecond later would otherwise take the recorder down with everything it
 * observed. Before the child there is nothing yet to lose, so the default is right there.
 *
 * A signal that does arrive releases them at once, deliberately, so a second one is not queued
 * behind the first. The corpus write that follows it therefore runs under Node's default again,
 * which is what makes "press it again to stop now" mean what it says.
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
    // Absorbed rather than acted on once the suite has gone: there is no child left to signal, and
    // what remains is the corpus write, which is the thing worth finishing. A second one still ends
    // the run at once, because the first released the handlers.
    const kill = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };

    for (const signal of FORWARDED_SIGNALS) {
      const handler = (): void => {
        // Released on the first signal, so a second Ctrl-C meets Node's default and kills at once.
        // Pressing it again is a request not to wait, and a suite that ignores the signal would
        // otherwise hold the recorder open for as long as it liked.
        release();
        interrupted ??= signal;
        if (shouldForward(signal, terminalAttached())) kill(signal);
      };
      installed.set(signal, handler);
      process.on(signal, handler);
    }

    child.on('error', (error) => {
      release();
      reject(error);
    });
    child.on('close', (code, signal) => {
      // No `release()` here: on an uninterrupted run the handlers stay up until `run` has written
      // the corpus. An interrupted one released them when the signal arrived. See the docstring.
      //
      // What ended this run was the interrupt, whatever the child made of it. A suite that traps
      // `SIGINT` and exits 0 did not turn an interrupted run into a successful one, and the exit
      // code is what a shell loop or a CI step branches on.
      if (interrupted !== undefined) {
        resolvePromise({ status: 128 + signalNumber(interrupted), interrupted, release });
        return;
      }
      // The shell convention, so that a suite killed by a signal is not reported as a clean run.
      resolvePromise({
        status: signal === null ? (code ?? 0) : 128 + signalNumber(signal),
        release,
      });
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
