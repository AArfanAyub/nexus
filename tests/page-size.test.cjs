/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * A static guard for the page-size contract.
 *
 * `entity.list` rejects anything above `MAX_PAGE_SIZE` with
 * `VALIDATION: Must be 200 or less`. When a screen asked for 500, the promise
 * rejected inside a query hook that swallows errors, so the dropdown simply
 * rendered empty and the user was told "a destination location is required".
 * Three create flows were dead for exactly this reason and no runtime test could
 * see it, because nothing threw anywhere the UI reports.
 *
 * This test reads the source instead: every `limit:` handed to `entity.list`
 * must be within the cap, or the number must be the shared constant.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { MAX_PAGE_SIZE } = require('../dist/main/shared/types.js');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');

function files(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every `limit:` literal that appears within one `entity.list` call. */
function limitSites() {
  const sites = [];
  for (const file of files(ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    // Scan from the channel name rather than matching the whole call: the
    // generic argument can contain `>>` (`Paged<ProductOption>>`), which makes a
    // balanced-paren regex fragile in exactly the way that hid this bug.
    const marker = "'entity.list'";
    let index = source.indexOf(marker);
    while (index !== -1) {
      const window = source.slice(index, index + 400);
      const literal = /limit:\s*(\d+)/.exec(window);
      const constant = /limit:\s*MAX_PAGE_SIZE/.test(window);
      if (literal || constant) {
        sites.push({
          file: path.relative(path.join(__dirname, '..'), file),
          line: source.slice(0, index).split('\n').length,
          value: literal ? Number(literal[1]) : MAX_PAGE_SIZE,
        });
      }
      index = source.indexOf(marker, index + marker.length);
    }
  }
  return sites;
}

test('T12-01 every entity.list call stays within MAX_PAGE_SIZE', () => {
  const sites = limitSites();
  assert.ok(sites.length >= 5, `expected to find list calls, found ${sites.length}`);
  const over = sites.filter((site) => site.value > MAX_PAGE_SIZE);
  assert.deepEqual(
    over,
    [],
    `these calls exceed the ${MAX_PAGE_SIZE}-row cap and will be rejected at runtime: ` +
      over.map((site) => `${site.file}:${site.line} (${site.value})`).join(', '),
  );
});

test('T12-02 the validator and the callers share one constant', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'schemas.ts'), 'utf8');
  assert.match(schema, /max:\s*MAX_PAGE_SIZE/, 'the entity list schema must use MAX_PAGE_SIZE, not a literal');
  assert.doesNotMatch(
    schema,
    /entity: v\.string[\s\S]{0,400}?limit: v\.optional\(v\.int\(\{ min: 1, max: 200 \}\)\)/,
    'a literal 200 in the entity list schema means the two ends can drift again',
  );
});
