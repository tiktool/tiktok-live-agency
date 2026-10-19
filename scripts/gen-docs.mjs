#!/usr/bin/env node
// Renders the generated tables in both READMEs and both llms.txt files from spec/methods.json,
// and mirrors llms.txt to the website. `--check` exits 1 when anything is out of date.
// The Python package is updated when a checkout sits next to this one; `--check` only covers it
// inside the monorepo, so a standalone clone of this package never fails on another repo's files.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pkgRoot, '..');
const pyRoot = join(repoRoot, 'tiktok-live-agency-python');
const siteMirror = join(repoRoot, 'tiktool-live-nuxt-cf', 'public', 'sdk', 'agency', 'llms.txt');
const check = process.argv.includes('--check');
const inMonorepo = existsSync(join(repoRoot, 'tiktool-live-nuxt-cf', 'public'));
const withPython = existsSync(pyRoot) && (inMonorepo || !check);

const spec = JSON.parse(readFileSync(join(pkgRoot, 'spec', 'methods.json'), 'utf8'));

// The spec ships in the npm tarball, so it must describe the public API only.
const ALLOWED_KEYS = new Set(['group', 'name', 'py', 'kind', 'http', 'path', 'query', 'minTier', 'returns', 'summary', 'endpointNote']);
for (const m of spec.methods) {
  const extra = Object.keys(m).filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length) throw new Error(`spec/methods.json: ${m.name} has unexpected keys: ${extra.join(', ')}`);
}
const tierOrder = Object.keys(spec.tiers);
const tierLabel = (t) => spec.tiers[t] ?? t;
const GROUPS = {
  account: 'Account',
  recruit: 'Find creators to recruit',
  rankings: 'Rankings and market',
  vet: 'Vet a creator',
  stats: 'Creator stats',
  roster: 'Rosters',
  live: 'Live status',
  firehose: 'Big gifts firehose',
  eligibility: 'Eligibility verdicts',
  webhooks: 'Webhooks',
};

const cell = (s) => String(s).replace(/\|/g, '\\|');

function endpoint(m) {
  if (m.kind === 'local') return 'local';
  if (m.kind === 'ws') return `\`WS ${m.path}\``;
  const q = m.query ? '?' + Object.entries(m.query).map(([k, v]) => `${k}=${v}`).join('&') : '';
  const base = `\`${m.http} ${m.path}${q}\``;
  return m.endpointNote ? `${base} (${m.endpointNote})` : base;
}

function plansTable(lang) {
  const rows = [];
  for (const [group, label] of Object.entries(GROUPS)) {
    const inGroup = spec.methods.filter((m) => m.group === group && m.kind !== 'local');
    for (const tier of tierOrder) {
      const names = inGroup.filter((m) => m.minTier === tier).map((m) => (lang === 'py' ? m.py : m.name)).sort();
      if (names.length) rows.push(`| ${label} | ${names.map((n) => `\`${n}\``).join(', ')} | ${tierLabel(tier)} |`);
    }
  }
  return ['| Task | Method | Minimum plan |', '| --- | --- | --- |', ...rows].join('\n');
}

function methodsTable(lang) {
  const head = lang === 'py'
    ? ['| Python | TypeScript | Endpoint | Plan | Returns |', '| --- | --- | --- | --- | --- |']
    : ['| Method | Python | Endpoint | Plan | Returns |', '| --- | --- | --- | --- | --- |'];
  const rows = spec.methods.map((m) => {
    const [a, b] = lang === 'py' ? [m.py, m.name] : [m.name, m.py];
    return `| \`${a}\` | \`${b}\` | ${endpoint(m)} | ${tierLabel(m.minTier)} | \`${cell(m.returns)}\` |`;
  });
  return [...head, ...rows].join('\n');
}

function llmsList(lang) {
  return spec.methods.map((m) => {
    const names = lang === 'py' ? `${m.py} / ${m.name}` : `${m.name} / ${m.py}`;
    const where = m.kind === 'local' ? 'local, no request' : endpoint(m).replace(/`/g, '');
    return `- ${names}: ${where} (${tierLabel(m.minTier)}). ${m.summary}`;
  }).join('\n');
}

function replaceBlock(text, name, body, file) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i < 0 || j < i) throw new Error(`${file}: missing ${start} ... ${end}`);
  return text.slice(0, i + start.length) + '\n' + body + '\n' + text.slice(j);
}

const targets = [
  { file: join(pkgRoot, 'README.md'), blocks: { plans: plansTable('ts'), methods: methodsTable('ts') } },
  { file: join(pkgRoot, 'llms.txt'), blocks: { methods: llmsList('ts') } },
  ...(withPython ? [
    { file: join(pyRoot, 'README.md'), blocks: { plans: plansTable('py'), methods: methodsTable('py') } },
    { file: join(pyRoot, 'llms.txt'), blocks: { methods: llmsList('py') } },
  ] : []),
];

let stale = [];
const write = (file, next) => {
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (prev === next) return;
  if (check) { stale.push(file); return; }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  console.log(`updated ${file}`);
};

for (const t of targets) {
  if (!existsSync(t.file)) throw new Error(`missing ${t.file}`);
  let text = readFileSync(t.file, 'utf8');
  for (const [name, body] of Object.entries(t.blocks)) text = replaceBlock(text, name, body, t.file);
  write(t.file, text);
}

// The website serves the npm llms.txt at tik.tools/sdk/agency/llms.txt.
if (inMonorepo) {
  let llms = readFileSync(join(pkgRoot, 'llms.txt'), 'utf8');
  for (const [name, body] of Object.entries(targets[1].blocks)) llms = replaceBlock(llms, name, body, 'llms.txt');
  write(siteMirror, llms);
}

if (stale.length) {
  console.error(`Out of date (run npm run docs):\n${stale.join('\n')}`);
  process.exit(1);
}
