import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import * as esm from '../dist/index.mjs';
import * as webhooksEsm from '../dist/webhooks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..');
const spec = JSON.parse(readFileSync(join(pkgRoot, 'spec', 'methods.json'), 'utf8'));
const require = createRequire(import.meta.url);

const LOCAL_EXPORTS = { isFreeToJoin: esm.isFreeToJoin, verifyWebhook: webhooksEsm.verifyWebhook, toDiscordMessage: webhooksEsm.toDiscordMessage };

test('every manifest method exists on the client or as an export', () => {
  const proto = esm.AgencyClient.prototype;
  for (const m of spec.methods) {
    if (m.kind === 'local') assert.equal(typeof LOCAL_EXPORTS[m.name], 'function', `${m.name} export missing`);
    else assert.equal(typeof proto[m.name], 'function', `AgencyClient.${m.name} missing`);
  }
});

test('manifest entries are well formed', () => {
  const tiers = Object.keys(spec.tiers);
  const names = new Set();
  for (const m of spec.methods) {
    assert.ok(!names.has(m.name), `duplicate ${m.name}`);
    names.add(m.name);
    assert.match(m.py, /^[a-z][a-z0-9_]*$/, `${m.name} py name`);
    assert.ok(tiers.includes(m.minTier), `${m.name} tier ${m.minTier}`);
    if (m.kind === 'endpoint' || m.kind === 'helper') assert.match(m.path, /^\//, `${m.name} path`);
    if (m.kind === 'endpoint') assert.ok(['GET', 'POST', 'PATCH', 'DELETE'].includes(m.http), `${m.name} http`);
  }
});

test('CommonJS build and subpath exports load', () => {
  const cjs = require('../dist/index.js');
  assert.equal(typeof cjs.AgencyClient, 'function');
  assert.equal(typeof require('../dist/webhooks.js').verifyWebhook, 'function');
  assert.equal(typeof require('../dist/firehose.js').streamBigGifts, 'function');
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.ok(pkg.exports['./webhooks'] && pkg.exports['./firehose']);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'zero runtime dependencies');
});

// Checks against the tik.tools monorepo (API tier map, docs catalogue) live next to the monorepo sources and
// load only when present, so a standalone clone of this package runs without them.
const monorepoChecks = join(repoRoot, 'tests', 'agency-sdk-catalogue.check.mjs');
if (existsSync(monorepoChecks)) await import(pathToFileURL(monorepoChecks).href);

test('README and llms.txt reference tables are current', () => {
  const out = require('node:child_process').spawnSync(process.execPath, [join(pkgRoot, 'scripts', 'gen-docs.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
});
