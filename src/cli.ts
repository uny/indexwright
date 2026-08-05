#!/usr/bin/env node
import { appendFileSync, realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs, usage, UsageError } from './args.js';
import { formatGithub } from './format/github.js';
import { formatJson } from './format/json.js';
import { formatText } from './format/text.js';
import { lintFiles } from './lint.js';
import { VERSION } from './version.js';

export interface Streams {
  out(text: string): void;
  err(text: string): void;
}

/**
 * Exit codes (SPEC §4): 0 completed, 1 warnings over the budget, 2 usage error or unusable input.
 * A file that could not be analysed is a 2 regardless of `--max-warnings`, because the run did not
 * cover what it was asked to cover.
 */
export function run(argv: readonly string[], streams: Streams): number {
  let command;
  try {
    command = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    streams.err(`indexwright: ${error.message}\n\n${usage()}\n`);
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

  const result = lintFiles(command.files, {
    rules: command.rules,
    quota: command.quota,
    quotaThreshold: command.quotaThreshold,
  });

  switch (command.format) {
    case 'json':
      streams.out(formatJson(result));
      break;
    case 'github': {
      const { commands, summary } = formatGithub(result);
      streams.out(commands);
      writeStepSummary(summary, streams);
      break;
    }
    case 'text':
      streams.out(formatText(result));
      break;
  }

  if (result.summary.errors > 0) return 2;
  if (result.summary.warnings > command.maxWarnings) return 1;
  return 0;
}

function writeStepSummary(summary: string, streams: Streams): void {
  const target = process.env['GITHUB_STEP_SUMMARY'];
  if (!target) {
    streams.out(summary);
    return;
  }
  try {
    appendFileSync(target, summary);
  } catch (error) {
    // A summary that cannot be written must not change the verdict of the lint.
    streams.err(`indexwright: could not write GITHUB_STEP_SUMMARY: ${(error as Error).message}\n`);
    streams.out(summary);
  }
}

/**
 * npm installs the bin as a symlink, so `process.argv[1]` is the link while `import.meta.url` is
 * the real path. Comparing without resolving the link would leave the installed CLI doing nothing.
 */
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
  process.exitCode = run(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
