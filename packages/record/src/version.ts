import { readFileSync } from 'node:fs';

/** Read from package.json rather than duplicated in source, for the reason `indexwright` does. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}

export const VERSION: string = readVersion();
