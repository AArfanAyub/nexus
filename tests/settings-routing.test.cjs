/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Regression tests for the Settings sub-tab bug (T11-4).
 *
 * Two defects shipped in the same release and neither needed a browser to
 * catch, so both are pinned here without Electron or a renderer bundle:
 *
 *   1. the sub-tab was seeded into `useState(tab)`, so a route change updated
 *      the prop but the component kept rendering the tab it first mounted
 *      with. The guard is structural: the active tab must be *derived* from the
 *      route prop, and the tab→route map must be total and one-to-one.
 *   2. `/settings/roles` crashed because `entity.list` returns a raw snake_case
 *      row (`permissions_json`) that was cast to `Role`, so
 *      `selected.permissions.length` threw, and because `permissions.catalog`
 *      items are `{key,label,risk}` objects that were rendered as children
 *      (React error #31).
 *
 * The `toRole` under test is the real function, lifted out of `People.tsx` and
 * transpiled with the project's own TypeScript — not a copy. A re-implemented
 * helper would pass even if the component regressed.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const SHARED = path.join(ROOT, 'dist', 'main', 'shared');
const { isPermission, permissionGroups, PERMISSION_KEYS } = require(path.join(SHARED, 'permissions.js'));

const DATA_PAGE = path.join(ROOT, 'src', 'renderer', 'pages', 'settings', 'Data.tsx');
const PEOPLE_PAGE = path.join(ROOT, 'src', 'renderer', 'pages', 'settings', 'People.tsx');
const SYSTEM_PAGE = path.join(ROOT, 'src', 'renderer', 'pages', 'settings', 'System.tsx');
const APP = path.join(ROOT, 'src', 'renderer', 'App.tsx');

const read = (file) => fs.readFileSync(file, 'utf8');

// ── source parsing helpers ───────────────────────────────────────────────────

/** Pulls the pairs out of `const NAME ... = { a: 'x', b: 'y' };`. */
function parseMap(source, name) {
  const pattern = new RegExp(`const ${name}\\b[\\s\\S]*?=\\s*\\{([\\s\\S]*?)\\}\\s*(?:as const)?\\s*;`);
  const match = source.match(pattern);
  assert.ok(match, `could not find ${name} in the source`);
  const pairs = {};
  for (const entry of match[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'/g)) {
    pairs[entry[1]] = entry[2];
  }
  assert.ok(Object.keys(pairs).length > 0, `${name} parsed as empty`);
  return pairs;
}

/** Pulls the members out of `type NAME = 'a' | 'b';`. */
function parseUnion(source, name) {
  const match = source.match(new RegExp(`type ${name}\\s*=\\s*([^;]+);`));
  assert.ok(match, `could not find type ${name}`);
  return match[1]
    .split('|')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
}

/** `path: '/x', element: <DataSettings tab="y" />` pairs registered in App.tsx. */
function parseRegisteredRoutes(source) {
  const routes = [];
  for (const match of source.matchAll(
    /path:\s*'([^']+)',\s*element:\s*<(DataSettings|System|People)\s+tab="([A-Za-z]+)"/g,
  )) {
    routes.push({ path: match[1], component: match[2], tab: match[3] });
  }
  return routes;
}

/** Lifts a top-level `function name(...) { ... }` out of a source file, by braces. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `could not find function ${name}`);
  let index = source.indexOf('{', start);
  const bodyStart = index;
  let depth = 0;
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert.ok(bodyStart > 0, `could not find the body of ${name}`);
  return source.slice(start, index + 1);
}

// ── 1. the tab must be derived from the route, never mirrored into state ─────

test('settings tab is derived from the route prop, not seeded into useState', () => {
  const pages = [
    { file: 'Data.tsx', source: read(DATA_PAGE) },
    { file: 'People.tsx', source: read(PEOPLE_PAGE) },
    { file: 'System.tsx', source: read(SYSTEM_PAGE) },
  ];

  for (const { file, source } of pages) {
    assert.match(
      source,
      /const active = tab;/,
      `${file} must derive the active tab from the route prop`,
    );

    /*
     * The exact shape of the bug: the prop is read once, on mount, and React
     * keeps the component instance when only the path changes. Any of these
     * would reintroduce it.
     */
    const stateful = [
      /useState\(\s*tab\s*\)/,
      /useState<DataTab>/,
      /useState<SystemTab>/,
      /useState<\s*'users'\s*\|\s*'roles'\s*>/,
      /setTab\b/,
    ];
    for (const pattern of stateful) {
      assert.doesNotMatch(source, pattern, `${file} must not hold the tab in state (${pattern})`);
    }

    /* A useEffect that copies the prop into state breaks the back button. */
    assert.doesNotMatch(
      source,
      /useEffect\([^)]*setActive/,
      `${file} must not copy the tab prop into state inside an effect`,
    );
  }
});

// ── 2. the tab → route maps are total and one-to-one ────────────────────────

const REGISTERED = parseRegisteredRoutes(read(APP));
const DATA_ROUTES = parseMap(read(DATA_PAGE), 'DATA_ROUTES');
const DATA_LABELS = parseMap(read(DATA_PAGE), 'DATA_LABELS');
const DATA_TABS = parseUnion(read(DATA_PAGE), 'DataTab');
const SYSTEM_ROUTES = parseMap(read(SYSTEM_PAGE), 'SYSTEM_ROUTES');
const SYSTEM_LABELS = parseMap(read(SYSTEM_PAGE), 'SYSTEM_LABELS');
const SYSTEM_TABS = parseUnion(read(SYSTEM_PAGE), 'SystemTab');
const PEOPLE_ROUTES = parseMap(read(PEOPLE_PAGE), 'PEOPLE_ROUTES');
const PEOPLE_TABS = ['users', 'roles'];

const MODULES = [
  { name: 'Data', component: 'DataSettings', tabs: DATA_TABS, routes: DATA_ROUTES, labels: DATA_LABELS },
  { name: 'System', component: 'System', tabs: SYSTEM_TABS, routes: SYSTEM_ROUTES, labels: SYSTEM_LABELS },
  { name: 'People', component: 'People', tabs: PEOPLE_TABS, routes: PEOPLE_ROUTES, labels: null },
];

for (const module of MODULES) {
  test(`${module.name}: every tab has a route and every route has a tab (total)`, () => {
    for (const tab of module.tabs) {
      assert.ok(module.routes[tab], `${module.name} tab "${tab}" has no route`);
    }
    for (const tab of Object.keys(module.routes)) {
      assert.ok(module.tabs.includes(tab), `${module.name} maps an unknown tab "${tab}"`);
    }
    assert.equal(
      Object.keys(module.routes).length,
      module.tabs.length,
      `${module.name} route map and tab union disagree`,
    );
  });

  test(`${module.name}: the tab → route map is one-to-one`, () => {
    const routes = Object.values(module.routes);
    assert.equal(
      new Set(routes).size,
      routes.length,
      `${module.name} has two tabs pointing at the same route: ${JSON.stringify(module.routes)}`,
    );
  });

  test(`${module.name}: every mapped route is registered in App.tsx with that tab`, () => {
    for (const [tab, route] of Object.entries(module.routes)) {
      const match = REGISTERED.filter((entry) => entry.path === route);
      assert.equal(match.length, 1, `${route} must be registered exactly once in App.tsx`);
      assert.equal(
        match[0].component,
        module.component,
        `${route} must render <${module.component}>`,
      );
      assert.equal(match[0].tab, tab, `${route} must pass tab="${tab}"`);
    }
  });

  if (module.labels) {
    test(`${module.name}: the heading names the tab, and no two tabs share a heading`, () => {
      for (const tab of module.tabs) {
        assert.ok(module.labels[tab], `${module.name} tab "${tab}" has no heading label`);
      }
      const headings = Object.values(module.labels);
      assert.equal(
        new Set(headings).size,
        headings.length,
        `${module.name} has duplicate headings: ${JSON.stringify(module.labels)}`,
      );
    });
  }
}

test('all 12 settings sub-routes are registered and none is duplicated', () => {
  const expected = [
    '/settings/numbering',
    '/settings/taxes',
    '/settings/currencies',
    '/settings/custom-fields',
    '/settings/import',
    '/settings/users',
    '/settings/roles',
    '/settings/license',
    '/settings/audit-log',
    '/settings/backup',
    '/settings/security',
    '/settings/appearance',
  ];
  const registered = REGISTERED.map((entry) => entry.path);
  for (const route of expected) {
    assert.equal(
      registered.filter((value) => value === route).length,
      1,
      `${route} must be registered exactly once`,
    );
  }
  assert.equal(new Set(registered).size, registered.length, 'a settings route is registered twice');
  assert.equal(registered.length, expected.length, 'unexpected number of settings routes');
});

// ── 3. toRole: the raw row the database actually returns ────────────────────

const toRoleSource = ts.transpileModule(extractFunction(read(PEOPLE_PAGE), 'toRole'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

// eslint-disable-next-line no-new-func
const toRole = new Function('isPermission', `${toRoleSource}\nreturn toRole;`)(isPermission);

/** A raw `entity.list` row for the `roles` table — snake_case, JSON as a string. */
function rawRole(overrides = {}) {
  return {
    id: 'role-1',
    name: 'Accountant',
    description: 'Keeps the books',
    is_system: 0,
    permissions_json: '["finance.invoice.read","settings.role.read"]',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

test('toRole parses a raw permissions_json row into an array of valid keys', () => {
  const role = toRole(rawRole());

  assert.equal(role.id, 'role-1');
  assert.equal(role.name, 'Accountant');
  assert.equal(role.description, 'Keeps the books');
  assert.equal(role.isSystem, false);
  assert.ok(Array.isArray(role.permissions), 'permissions must be an array');
  assert.deepEqual(role.permissions, ['finance.invoice.read', 'settings.role.read']);
  for (const permission of role.permissions) {
    assert.ok(isPermission(permission), `${permission} is not a real permission`);
  }
});

test('toRole never returns a non-array permissions value (the crash was .length)', () => {
  const rows = [
    rawRole(),
    rawRole({ permissions_json: undefined }),
    rawRole({ permissions_json: null }),
    rawRole({ permissions_json: '' }),
    rawRole({ permissions_json: 'not json at all' }),
    rawRole({ permissions_json: '{"not":"an array"}' }),
    rawRole({ permissions_json: 'null' }),
    rawRole({ permissions_json: '[1,2,3]' }),
    rawRole({ permissions_json: '[null,{},""]' }),
    rawRole({ permissions_json: '["made.up.permission"]' }),
    rawRole({ is_system: 1 }),
    {},
  ];

  for (const row of rows) {
    const role = toRole(row);
    assert.ok(Array.isArray(role.permissions), `permissions must be an array for ${JSON.stringify(row)}`);
    assert.doesNotThrow(() => role.permissions.length);
    for (const permission of role.permissions) {
      assert.ok(isPermission(permission), `${String(permission)} survived the filter but is not a permission`);
    }
  }
});

test('toRole drops permission keys the catalogue does not know', () => {
  const role = toRole(
    rawRole({ permissions_json: '["finance.invoice.read","made.up.permission","__proto__","constructor"]' }),
  );
  assert.deepEqual(role.permissions, ['finance.invoice.read']);
});

test('toRole maps is_system and tolerates missing optional columns', () => {
  assert.equal(toRole(rawRole({ is_system: 1 })).isSystem, true);
  assert.equal(toRole(rawRole({ is_system: '1' })).isSystem, true);
  assert.equal(toRole(rawRole({ is_system: 0 })).isSystem, false);
  assert.equal(toRole(rawRole({ is_system: undefined })).isSystem, false);

  const sparse = toRole({ id: 'r', name: 'Bare' });
  assert.equal(sparse.description, null);
  assert.equal(sparse.createdAt, '');
  assert.equal(sparse.updatedAt, '');
  assert.deepEqual(sparse.permissions, []);
});

test('toRole coerces ids and names to strings', () => {
  const role = toRole(rawRole({ id: 42, name: 7 }));
  assert.equal(typeof role.id, 'string');
  assert.equal(typeof role.name, 'string');
});

// ── 4. the permission catalogue shape that React error #31 came from ────────

test('permissions.catalog items are objects with a label, not bare strings', () => {
  const groups = permissionGroups();

  assert.ok(groups.length > 0, 'the catalogue must not be empty');

  for (const group of groups) {
    assert.equal(typeof group.module, 'string');
    assert.ok(Array.isArray(group.items), `${group.module} items must be an array`);
    assert.ok(group.items.length > 0, `${group.module} has no permissions`);

    for (const item of group.items) {
      /*
       * Rendering one of these directly as a React child is error #31, which is
       * what took the whole route down. If the shape ever changes back to a
       * string, this fails instead of the UI.
       */
      assert.equal(typeof item, 'object', `${group.module} contains a bare ${typeof item}`);
      assert.notEqual(item, null);
      assert.equal(typeof item.label, 'string', 'every permission needs a label to render');
      assert.ok(item.label.length > 0, `${String(item.key)} has an empty label`);
      assert.equal(typeof item.key, 'string');
      assert.ok(isPermission(item.key), `${String(item.key)} is not a permission`);
      assert.ok(['low', 'medium', 'high'].includes(item.risk), `${item.key} has an unknown risk`);
    }
  }
});

test('every permission in the catalogue appears exactly once', () => {
  const keys = permissionGroups().flatMap((group) => group.items.map((item) => item.key));
  assert.equal(new Set(keys).size, keys.length, 'a permission is listed twice');
  assert.equal(keys.length, PERMISSION_KEYS.length, 'the catalogue is missing permissions');
});

test('the roles panel renders a non-empty matrix for a default role', () => {
  /*
   * The UI shows one checkbox per catalogue item, so a role whose stored JSON is
   * empty still renders the full matrix. This is the count a screenshot shows.
   */
  const total = permissionGroups().reduce((sum, group) => sum + group.items.length, 0);
  assert.ok(total > 0);

  const role = toRole(rawRole({ permissions_json: '[]' }));
  assert.equal(role.permissions.length, 0);
  const ticked = permissionGroups().filter((group) => group.items.some((item) => role.permissions.includes(item.key)));
  assert.equal(ticked.length, 0, 'an empty role must tick nothing');
});
