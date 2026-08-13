import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * SPEC §8 states the dependency-free property as something that holds in every version, not as an
 * aspiration, so it is asserted rather than left to review. Every field here installs into an
 * adopter's tree: npm resolves peers automatically, and an optional dependency is installed when
 * it can be. A verb that genuinely needs a library ships as `@indexwright/record` (§3) instead.
 */
test('the linter declares nothing that would install into an adopter tree', () => {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.deepEqual(manifest[field] ?? {}, {}, `${field} must stay empty`);
  }
});
