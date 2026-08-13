import { readFileSync } from 'node:fs';

/**
 * Read from package.json rather than duplicated in source, so a release cannot ship a `version`
 * field in the JSON output that disagrees with the package it came from.
 */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}

export const VERSION: string = readVersion();
