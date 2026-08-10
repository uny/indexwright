import { fileURLToPath } from 'node:url';
import { lintFiles } from '../dist/index.js';

/** Fixtures encode the invariant; real project files are for manual exploration only (SPEC §9). */
export function fixture(name) {
  return fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
}

export function lintFixtures(names, options = {}) {
  return lintFiles(names.map(fixture), options);
}

/** Findings of one rule, so a fixture that happens to trip another rule cannot skew a count. */
export function findingsFor(result, rule) {
  return result.findings.filter((finding) => finding.rule === rule);
}
