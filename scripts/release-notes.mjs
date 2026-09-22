// The body of a GitHub Release, cut from a package's CHANGELOG.
//
//   node scripts/release-notes.mjs <changelog> <version>
//
// Prints the section headed `## [<version>]` — everything under the heading up to the next `## `
// — followed by a link to that section in the changelog on `main`, so the release page and the
// file it was cut from are one text rather than two that drift. The heading itself is left out:
// the release carries the version in its name.
//
// A version the changelog does not have a section for is an error, and so is a section with
// nothing under its heading. The release workflows run this on the tag, after the publish, and a
// tag whose changelog was not closed is the mistake worth failing on rather than shipping a blank
// release page over.
//
// Node's own modules only, so the release job that runs it installs nothing.

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

const [changelog, version] = process.argv.slice(2);
if (!changelog || !version) {
  console.error('usage: release-notes.mjs <changelog> <version>');
  process.exit(2);
}

const text = readFileSync(changelog, 'utf8');
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n`, 'm');
const start = text.search(heading);
if (start === -1) {
  console.error(`${changelog} has no "## [${version}]" section`);
  process.exit(1);
}
const bodyStart = start + text.match(heading)[0].length;
const next = text.slice(bodyStart).search(/^## /m);
const body = (next === -1 ? text.slice(bodyStart) : text.slice(bodyStart, bodyStart + next)).trim();
if (body === '') {
  console.error(`${changelog}'s "## [${version}]" section is empty`);
  process.exit(1);
}

// The anchor GitHub gives a `## [0.9.0] — 2026-09-22` heading: lowercased, punctuation dropped,
// spaces to hyphens. The em dash is punctuation and goes; its surrounding spaces stay as hyphens.
const line = text.slice(start, bodyStart).trim().replace(/^## /, '');
const anchor = line
  .toLowerCase()
  .replace(/[^\p{L}\p{N} -]/gu, '')
  .replace(/ /g, '-');
const path = relative(process.cwd(), changelog).split('\\').join('/');
const link = `https://github.com/uny/indexwright/blob/main/${path}#${anchor}`;

process.stdout.write(`${body}\n\nThe [changelog](${link}) carries this entry.\n`);
