// Tests for the Stage 7 follow-up in the QA plugin: the release readiness artifact,
// flexible bug identity in readiness artifacts, and the ledger freshness token.
//
// Run: node --test scripts/qa-release-readiness.test.mjs
// QA_LEDGER_HELPER overrides the helper path (used by qa-ledger.mutation.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = process.env.QA_LEDGER_HELPER || path.join(HERE, 'qa-ledger.mjs');
const QA_FIX = path.join(HERE, 'fixtures', 'qa-ledger');

function workspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-release-test-')));
  const qa = path.join(ws, 'acme-qa');
  fs.mkdirSync(path.join(qa, '.git'), { recursive: true });
  for (const f of ['checkout/test-plan.md', 'cart/test-plan.md', 'smoke/android/smoke-suite.md', 'smoke/android-tv/smoke-suite.md']) {
    fs.mkdirSync(path.dirname(path.join(qa, f)), { recursive: true });
    fs.copyFileSync(path.join(QA_FIX, f), path.join(qa, f));
  }
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 2, 9, 0, 0) + tick++ * 1000).toISOString();
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [HELPER, ...args, '--qa-repo', qa], { encoding: 'utf8', env: { ...process.env, QA_LEDGER_NOW: now() } });
    let json = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      /* asserted by callers */
    }
    return { code: r.status, json, out: r.stdout + r.stderr };
  };
  const ok = (...args) => {
    const r = cli(...args);
    assert.equal(r.code, 0, `expected success for ${args.join(' ')}\n${r.out}`);
    return r.json;
  };
  const refused = (code, ...args) => {
    const r = cli(...args);
    assert.notEqual(r.code, 0, `expected refusal ${code} for ${args.join(' ')}\n${r.out}`);
    if (code) assert.equal(r.json.error.code, code, JSON.stringify(r.json.error));
    return r.json;
  };
  const readiness = (scope) => ok('view', 'readiness', '--scope', scope).readiness;
  return { ws, qa, cli, ok, refused, readiness };
}

function smoke(w, build, surface, scope) {
  const run = w.ok('run', 'open', '--type', 'smoke', '--scope', scope, '--build', build, '--surface', surface, '--device', 'Device', '--executor', 'dana', '--plan', `smoke/${surface}/smoke-suite.md`).run_id;
  for (const c of w.ok('view', 'run-cases', '--run', run).cases) w.ok('result', 'add', '--run', run, '--case', c.case_key, '--result', 'pass');
  w.ok('run', 'close', '--run', run);
}
function readyFeature(w, slug, plan, build) {
  w.ok('scope', 'create', '--scope', `feature:${slug}`, '--created-by', 'dana');
  w.ok('scope', 'event', '--scope', `feature:${slug}`, '--op', 'add', '--field', 'plans', '--value', JSON.stringify(plan), '--by', 'dana');
  w.ok('scope', 'event', '--scope', `feature:${slug}`, '--op', 'set', '--field', 'surfaces', '--value', '["android"]', '--by', 'dana');
  w.ok('scope', 'event', '--scope', `feature:${slug}`, '--op', 'set', '--field', 'devices', '--value', '[{"surface":"android","device":"Pixel 8"}]', '--by', 'dana');
  w.ok('build', 'add', '--id', build, '--surfaces', 'android', '--registered-by', 'dana', '--related-scope', `feature:${slug}`);
  smoke(w, build, 'android', `feature:${slug}`);
  const run = w.ok('run', 'open', '--type', 'functional', '--scope', `feature:${slug}`, '--build', build, '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', plan).run_id;
  for (const c of w.ok('view', 'run-cases', '--run', run).cases) w.ok('result', 'add', '--run', run, '--case', c.case_key, '--result', 'pass');
  w.ok('run', 'close', '--run', run);
  w.ok('regression', 'decide', '--scope', `feature:${slug}`, '--by', 'dana', '--required', 'no', '--reason', 'Isolated');
}
function readyBug(w, { external = 'JIRA-4411' } = {}) {
  w.ok('bug', 'report', '--id', 'BUG-27', '--title', 'Player freezes', '--step', 's', '--expected', 'e', '--actual', 'a', '--severity', 'major', '--surfaces', 'android-tv', '--by', 'dana', ...(external ? ['--external-ref', external] : []));
  w.ok('build', 'add', '--id', 'atv-103', '--surfaces', 'android-tv', '--registered-by', 'dana');
  w.ok('bug', 'verify', '--bug', 'bug:BUG-27', '--build', 'atv-103', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'reproduced');
  w.ok('build', 'add', '--id', 'atv-104', '--surfaces', 'android-tv', '--registered-by', 'omer', '--fixes', 'bug:BUG-27');
  smoke(w, 'atv-104', 'android-tv', 'bug:BUG-27');
  w.ok('bug', 'retest', '--bug', 'bug:BUG-27', '--build', 'atv-104', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'pass');
  w.ok('regression', 'decide', '--scope', 'bug:BUG-27', '--by', 'dana', '--required', 'no', '--reason', 'Player only');
}
function release(opts) {
  const w = workspace();
  w.ok('init');
  readyFeature(w, 'checkout', 'checkout/test-plan.md', '104');
  readyBug(w, opts);
  w.ok('scope', 'create', '--scope', 'release:2.4.0', '--created-by', 'dana');
  for (const m of ['feature:checkout', 'bug:BUG-27']) w.ok('scope', 'event', '--scope', 'release:2.4.0', '--op', 'add', '--field', 'members', '--value', JSON.stringify(m), '--by', 'dana');
  return w;
}
const fm = (text) => /^---\n([\s\S]*?)\n---\n/.exec(text)[1];

// ---------- Gap 1: the release readiness artifact ----------

test('G1-01 a release scope renders readiness/release/<id>.md in the contract style', () => {
  const w = release();
  const out = w.ok('readiness', 'render', '--scope', 'release:2.4.0');
  assert.equal(out.rendered, 'readiness/release/2.4.0.md');
  const text = fs.readFileSync(path.join(w.qa, 'readiness', 'release', '2.4.0.md'), 'utf8');
  const head = fm(text);
  for (const line of ['qa_readiness_schema: 2', 'scope: release:2.4.0', 'scope_kind: release', 'member_count: 2', 'verdict: READY', 'blocker_count: 0', 'exception_count: 0', 'signoff_status: none', 'candidate_builds:', '  - android: 104', '  - android-tv: atv-104']) assert.ok(head.includes(line), line);
  assert.match(head, /^fingerprint: sha256:[0-9a-f]{64}$/m);
  assert.match(head, /^freshness_token: sha256:[0-9a-f]{64}$/m);
  assert.ok(text.includes('## Members'));
  assert.ok(text.includes('| feature:checkout | feature | — | — | — | READY |'), 'feature member (no Dev handoff recorded)');
  assert.ok(text.includes('| bug:BUG-27 | bug | — | BUG-27 | JIRA-4411 | READY |'), 'bug member with both identities');
  for (const h of ['## Blockers', '## Per-Surface Matrix', '## Exceptions', '## Known Issues', '## Tested Builds', '## QA Notes', '## Release Notes Input']) assert.ok(text.includes(h), h);
  assert.equal(fs.readFileSync(path.join(w.qa, 'readiness', 'release', '2.4.0.md'), 'utf8'), (w.ok('readiness', 'render', '--scope', 'release:2.4.0'), fs.readFileSync(path.join(w.qa, 'readiness', 'release', '2.4.0.md'), 'utf8')), 'deterministic');
});

test('G1-02 release readiness aggregates features and bugs, blockers and exceptions', () => {
  const w = release();
  let r = w.readiness('release:2.4.0');
  assert.deepEqual(r.members.map((m) => [m.scope, m.kind, m.verdict]), [['feature:checkout', 'feature', 'READY'], ['bug:BUG-27', 'bug', 'READY']]);
  assert.deepEqual(r.tested_builds.sort(), ['104', 'atv-103', 'atv-104'].sort());
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'debt', '--value', '{"id":"HV-1","description":"VoiceOver","owner":"qa"}', '--by', 'dana');
  r = w.readiness('release:2.4.0');
  assert.equal(r.verdict, 'NOT_READY');
  assert.deepEqual(r.blockers.map((b) => [b.member, b.id]), [['feature:checkout', 'R8:HV-1']]);
  w.ok('readiness', 'except', '--scope', 'feature:checkout', '--item', 'R8:HV-1', '--kind', 'waived_debt', '--reason', 'After launch', '--approved-by', 'lead');
  r = w.readiness('release:2.4.0');
  assert.equal(r.verdict, 'READY_WITH_EXCEPTIONS');
  assert.deepEqual(r.exceptions.map((x) => [x.member, x.id, x.item]), [['feature:checkout', 'EX-1', 'R8:HV-1']]);
  const text = (w.ok('readiness', 'render', '--scope', 'release:2.4.0'), fs.readFileSync(path.join(w.qa, 'readiness', 'release', '2.4.0.md'), 'utf8'));
  assert.ok(fm(text).includes('exception_count: 1'));
  assert.ok(text.includes('| feature:checkout#EX-1 | R8:HV-1 | waived_debt |'));
  // Pins, exceptions and discharges stay member-level.
  w.refused('RELEASE_AGGREGATION_ONLY', 'readiness', 'except', '--scope', 'release:2.4.0', '--item', 'R8:HV-1', '--kind', 'waiver', '--reason', 'x', '--approved-by', 'lead');
  w.refused('RELEASE_AGGREGATION_ONLY', 'readiness', 'pin', '--scope', 'release:2.4.0', '--surface', 'android', '--build', '104', '--reason', 'x', '--by', 'dana');
});

test('G1-03 a release scope can be signed off, and its artifact shows the sign-off', () => {
  const w = release();
  const s = w.ok('readiness', 'signoff', '--scope', 'release:2.4.0', '--by', 'lead', '--notes', 'Release 2.4.0 approved by QA').signoff;
  assert.equal(s.verdict, 'READY');
  const head = fm(fs.readFileSync(path.join(w.qa, 'readiness', 'release', '2.4.0.md'), 'utf8'));
  assert.ok(head.includes('signed_off_by: lead') && head.includes('signoff_status: valid'));
  assert.equal(w.ok('view', 'signoffs', '--scope', 'release:2.4.0').signoffs[0].status, 'valid');
  const empty = workspace();
  empty.ok('init');
  empty.ok('scope', 'create', '--scope', 'release:9.9.9', '--created-by', 'dana');
  empty.refused('SIGNOFF_NOT_READY', 'readiness', 'signoff', '--scope', 'release:9.9.9', '--by', 'lead');
});

test('G1-04 any member change invalidates the release fingerprint and sign-off automatically', () => {
  const w = release();
  w.ok('readiness', 'signoff', '--scope', 'release:2.4.0', '--by', 'lead');
  const fp = w.readiness('release:2.4.0').fingerprint;
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'set', '--field', 'assignee', '--value', '"omer"', '--by', 'dana');
  assert.equal(w.readiness('release:2.4.0').verdict, 'READY');
  assert.notEqual(w.readiness('release:2.4.0').fingerprint, fp);
  assert.equal(w.ok('view', 'signoffs', '--scope', 'release:2.4.0').signoffs.at(-1).status, 'stale');
  assert.ok(w.ok('view', 'signoffs').stale.some((s) => s.scope === 'release:2.4.0'), 'stale release sign-offs are listed too');
});

test('G1-05 members that disagree on a surface’s candidate build block the release', () => {
  const w = release();
  readyFeature(w, 'cart', 'cart/test-plan.md', '105');
  w.ok('scope', 'event', '--scope', 'release:2.4.0', '--op', 'add', '--field', 'members', '--value', '"feature:cart"', '--by', 'dana');
  const r = w.readiness('release:2.4.0');
  assert.equal(r.verdict, 'NOT_READY');
  assert.ok(r.blockers.some((b) => b.id === 'RELEASE:candidate-conflict:android'));
  assert.deepEqual(r.candidate_builds.find((c) => c.surface === 'android'), { surface: 'android', build_id: null, pinned: false, conflict: ['104', '105'] });
});

// ---------- Gap 2: bug identity in the artifact ----------

test('G2-01 readiness artifacts carry the bug’s QA id and external_ref — either may be absent', () => {
  const w = release();
  w.ok('readiness', 'render', '--scope', 'bug:BUG-27');
  let head = fm(fs.readFileSync(path.join(w.qa, 'readiness', 'bug', 'BUG-27.md'), 'utf8'));
  assert.ok(head.includes('qa_bug_id: BUG-27') && head.includes('external_ref: JIRA-4411') && head.includes('dev_feature: null'));
  w.ok('readiness', 'render', '--scope', 'feature:checkout');
  head = fm(fs.readFileSync(path.join(w.qa, 'readiness', 'feature', 'checkout.md'), 'utf8'));
  assert.ok(head.includes('qa_bug_id: null') && head.includes('external_ref: null'));
  const noRef = release({ external: null });
  noRef.ok('readiness', 'render', '--scope', 'bug:BUG-27');
  head = fm(fs.readFileSync(path.join(noRef.qa, 'readiness', 'bug', 'BUG-27.md'), 'utf8'));
  assert.ok(head.includes('qa_bug_id: BUG-27') && head.includes('external_ref: null'));
});

// ---------- Gap 3: the freshness token ----------

test('G3-01 the freshness token moves with every record the scope could depend on', () => {
  const w = release();
  const token = () => w.readiness('feature:checkout').freshness_token;
  const seen = new Set([token()]);
  const changes = [
    () => w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'notes', '--value', '"n"', '--by', 'dana'),
    () => w.ok('bug', 'report', '--id', 'BUG-3', '--title', 't', '--step', 's', '--expected', 'e', '--actual', 'a', '--severity', 'minor', '--surfaces', 'android', '--related-scope', 'feature:checkout', '--by', 'dana'),
    () => w.ok('build', 'add', '--id', '106', '--surfaces', 'android', '--registered-by', 'dana', '--related-scope', 'feature:checkout'),
    () => smoke(w, '106', 'android', 'bug:BUG-27'),
    () => w.ok('run', 'abort', '--run', w.ok('run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'checkout/test-plan.md').run_id, '--reason', 'device lost'),
    () => {
      const plan = path.join(w.qa, 'checkout', 'test-plan.md');
      fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace('Open the cart', 'Open the basket'));
    },
  ];
  for (const change of changes) {
    change();
    const t = token();
    assert.ok(!seen.has(t), 'a relevant change moves the token');
    seen.add(t);
  }
});

test('G3-02 the freshness token ignores unrelated scopes, builds, runs, sign-offs and rendering', () => {
  const w = release();
  const before = w.readiness('feature:checkout').freshness_token;
  readyFeature(w, 'cart', 'cart/test-plan.md', '205');
  w.ok('build', 'add', '--id', 'ios-1', '--surfaces', 'ios', '--registered-by', 'dana');
  w.ok('readiness', 'signoff', '--scope', 'feature:checkout', '--by', 'lead');
  w.ok('readiness', 'render', '--scope', 'feature:checkout');
  assert.equal(w.readiness('feature:checkout').freshness_token, before);
  // A release's token is its own stream plus its members' tokens.
  const rel = w.readiness('release:2.4.0').freshness_token;
  w.ok('scope', 'event', '--scope', 'feature:cart', '--op', 'add', '--field', 'notes', '--value', '"unrelated to 2.4.0"', '--by', 'dana');
  assert.equal(w.readiness('release:2.4.0').freshness_token, rel);
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'add', '--field', 'notes', '--value', '"member change"', '--by', 'dana');
  assert.notEqual(w.readiness('release:2.4.0').freshness_token, rel);
});

test('G3-03 the artifact records the token it was rendered from', () => {
  const w = release();
  w.ok('readiness', 'render', '--scope', 'feature:checkout');
  const head = fm(fs.readFileSync(path.join(w.qa, 'readiness', 'feature', 'checkout.md'), 'utf8'));
  assert.ok(head.includes(`freshness_token: ${w.readiness('feature:checkout').freshness_token}`));
});

// ---------- artifact integrity (tamper evidence of the rendered Markdown) ----------

// The contract's algorithm, implemented independently of the helper: LF-normalize, drop the
// one artifact_integrity frontmatter line, sha256 the rest.
import crypto from 'node:crypto';
function integrityOf(text) {
  const t = text.replace(/\r\n/g, '\n');
  const end = t.indexOf('\n---\n', 4);
  const lines = t.slice(4, end).split('\n');
  const at = lines.findIndex((l) => l.startsWith('artifact_integrity: '));
  if (at < 0 || lines.filter((l) => l.startsWith('artifact_integrity:')).length !== 1) return { stored: null, computed: null };
  const rest = [...lines.slice(0, at), ...lines.slice(at + 1)];
  return { stored: lines[at].slice('artifact_integrity: '.length), computed: `sha256:${crypto.createHash('sha256').update(`---\n${rest.join('\n')}${t.slice(end)}`).digest('hex')}` };
}
const verifies = (text) => {
  const i = integrityOf(text);
  return /^sha256:[0-9a-f]{64}$/.test(i.stored ?? '') && i.stored === i.computed;
};
const artifact = (w, rel) => fs.readFileSync(path.join(w.qa, 'readiness', rel), 'utf8');

test('G4-01 feature, bug and release artifacts all carry a verifying artifact_integrity', () => {
  const w = release();
  for (const s of ['feature:checkout', 'bug:BUG-27', 'release:2.4.0']) w.ok('readiness', 'render', '--scope', s);
  for (const rel of ['feature/checkout.md', 'bug/BUG-27.md', 'release/2.4.0.md']) {
    const text = artifact(w, rel);
    assert.equal(fm(text).split('\n').filter((l) => l.startsWith('artifact_integrity:')).length, 1, rel);
    assert.ok(verifies(text), `${rel} verifies`);
  }
});

test('G4-02 the hash covers every line of the artifact except its own field', () => {
  const w = release();
  w.ok('readiness', 'signoff', '--scope', 'release:2.4.0', '--by', 'lead', '--notes', 'Approved');
  const text = artifact(w, 'release/2.4.0.md');
  const lines = text.split('\n');
  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('artifact_integrity:') || lines[i] === '---') continue;
    const edited = [...lines.slice(0, i), `${lines[i]}x`, ...lines.slice(i + 1)].join('\n');
    assert.ok(!verifies(edited), `an edit on line ${i + 1} (${lines[i].slice(0, 40)}) is detected`);
    checked++;
  }
  assert.ok(checked > 60);
  assert.ok(!verifies(text.replace(/artifact_integrity: sha256:[0-9a-f]{64}/, `artifact_integrity: sha256:${'0'.repeat(64)}`)), 'a replaced hash is detected');
  assert.ok(verifies(text.replace(/\n/g, '\r\n')), 'CRLF line endings normalize to the same hash');
});

test('G4-03 identical re-renders are byte-identical; a re-render after a change carries a new valid hash', () => {
  const w = release();
  w.ok('readiness', 'render', '--scope', 'bug:BUG-27');
  const first = artifact(w, 'bug/BUG-27.md');
  w.ok('readiness', 'render', '--scope', 'bug:BUG-27');
  assert.equal(artifact(w, 'bug/BUG-27.md'), first, 'stable across identical re-renders');
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'add', '--field', 'notes', '--value', '"re-checked"', '--by', 'dana');
  w.ok('readiness', 'render', '--scope', 'bug:BUG-27');
  const second = artifact(w, 'bug/BUG-27.md');
  assert.ok(verifies(second));
  assert.notEqual(integrityOf(second).stored, integrityOf(first).stored);
});
