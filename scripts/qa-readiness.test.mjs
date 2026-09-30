// Tests for QA lifecycle Stage 6 — deterministic QA readiness and sign-off, computed
// only from the ledger (Stages 1–5). Same harness style as the other ledger suites.
//
// Run: node --test scripts/qa-readiness.test.mjs
// QA_LEDGER_HELPER overrides the helper path (used by qa-ledger.mutation.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(HERE);
const HELPER = process.env.QA_LEDGER_HELPER || path.join(HERE, 'qa-ledger.mjs');
const QA_FIX = path.join(HERE, 'fixtures', 'qa-ledger');
const CASES = ['checkout/TC1', 'checkout/TC14', 'checkout/EC1', 'checkout/EC-U1', 'checkout/I18N1', 'checkout/A11Y1'];

function workspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-readiness-test-')));
  const qa = path.join(ws, 'acme-qa');
  fs.mkdirSync(path.join(qa, '.git'), { recursive: true });
  for (const f of ['checkout/test-plan.md', 'payments/test-plan.md', 'smoke/android/smoke-suite.md', 'smoke/ios/smoke-suite.md', 'smoke/android-tv/smoke-suite.md']) {
    fs.mkdirSync(path.dirname(path.join(qa, f)), { recursive: true });
    fs.copyFileSync(path.join(QA_FIX, f), path.join(qa, f));
  }
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 25, 9, 0, 0) + tick++ * 1000).toISOString();
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
    assert.equal(r.json?.ok, false, r.out);
    if (code) assert.equal(r.json.error.code, code, JSON.stringify(r.json.error));
    return r.json;
  };
  const readiness = (scope = 'feature:checkout') => ok('view', 'readiness', '--scope', scope).readiness;
  const blockerIds = (scope) => readiness(scope).blockers.filter((b) => !b.excepted_by).map((b) => b.id);
  return { ws, qa, cli, ok, refused, readiness, blockerIds, ledger: (...p) => path.join(qa, 'qa-ledger', ...p) };
}

function smoke(w, build, surface, results = [], scope = 'feature:checkout') {
  const run = w.ok('run', 'open', '--type', 'smoke', '--scope', scope, '--build', build, '--surface', surface, '--device', 'Device', '--executor', 'dana', '--plan', `smoke/${surface}/smoke-suite.md`).run_id;
  w.ok('view', 'run-cases', '--run', run).cases.forEach((c, i) => w.ok('result', 'add', '--run', run, '--case', c.case_key, '--result', results[i] ?? 'pass'));
  w.ok('run', 'close', '--run', run);
  return run;
}
function functional(w, build, results = {}, executor = 'dana') {
  const run = w.ok('run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', build, '--surface', 'android', '--device', 'Pixel 8', '--executor', executor, '--plan', 'checkout/test-plan.md').run_id;
  for (const c of CASES) if (results[c] !== null) w.ok('result', 'add', '--run', run, '--case', c, '--result', results[c] ?? 'pass');
  w.ok('run', 'close', '--run', run);
  return run;
}
const notRequired = (w, scope = 'feature:checkout') => w.ok('regression', 'decide', '--scope', scope, '--by', 'dana', '--required', 'no', '--reason', 'Isolated change — nothing shared');

// feature:checkout on android, approved plan, build 104 smoked, every case PASS, regression
// explicitly not required, no debt → READY.
function readyFeature({ decide = true, run = true } = {}) {
  const w = workspace();
  w.ok('init');
  w.ok('scope', 'create', '--scope', 'feature:checkout', '--created-by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'plans', '--value', '"checkout/test-plan.md"', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'surfaces', '--value', '["android"]', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'devices', '--value', '[{"surface":"android","device":"Pixel 8","os_runtime":"Android 15"}]', '--by', 'dana');
  w.ok('build', 'add', '--id', '104', '--surfaces', 'android', '--registered-by', 'dana', '--related-scope', 'feature:checkout');
  smoke(w, '104', 'android');
  if (run) w.run = functional(w, '104');
  if (decide) notRequired(w);
  return w;
}

// Standalone bug on android-tv: reproduced on atv-103, fixed in atv-104 (smoked).
function bugScope({ retest = 'pass' } = {}) {
  const w = workspace();
  w.ok('init');
  w.ok('bug', 'report', '--id', 'BUG-27', '--title', 'Player freezes after resume', '--step', 'Resume a movie', '--expected', 'Playback resumes', '--actual', 'Frozen', '--severity', 'major', '--surfaces', 'android-tv', '--by', 'dana');
  w.ok('build', 'add', '--id', 'atv-103', '--surfaces', 'android-tv', '--registered-by', 'dana');
  w.ok('bug', 'verify', '--bug', 'bug:BUG-27', '--build', 'atv-103', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'reproduced');
  w.ok('build', 'add', '--id', 'atv-104', '--surfaces', 'android-tv', '--registered-by', 'omer', '--fixes', 'bug:BUG-27');
  smoke(w, 'atv-104', 'android-tv', [], 'bug:BUG-27');
  if (retest) w.ok('bug', 'retest', '--bug', 'bug:BUG-27', '--build', 'atv-104', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', retest);
  return w;
}

// ---------- verdicts ----------

test('S6-01 a feature with every rule satisfied is READY', () => {
  const w = readyFeature();
  const r = w.readiness();
  assert.equal(r.verdict, 'READY');
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.candidate_builds, [{ surface: 'android', build_id: '104', pinned: false }]);
  assert.deepEqual(r.rules.map((x) => [x.rule, x.status]), [
    ['R1', 'pass'], ['R2', 'pass'], ['R3', 'pass'], ['R4', 'pass'], ['R5', 'pass'], ['R6', 'pass'], ['R7', 'not_applicable'], ['R8', 'pass'], ['R9', 'pass'],
  ]);
});

test('S6-02 NOT_READY when smoke has not accepted the candidate build', () => {
  const w = workspace();
  w.ok('init');
  w.ok('scope', 'create', '--scope', 'feature:checkout', '--created-by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'plans', '--value', '"checkout/test-plan.md"', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'surfaces', '--value', '["android"]', '--by', 'dana');
  w.ok('build', 'add', '--id', '104', '--surfaces', 'android', '--registered-by', 'dana', '--related-scope', 'feature:checkout');
  smoke(w, '104', 'android', ['pass', 'fail']);
  notRequired(w);
  const r = w.readiness();
  assert.equal(r.verdict, 'NOT_READY');
  assert.ok(w.blockerIds().includes('R9:android:candidate'), 'no accepted build → no candidate');
  w.ok('readiness', 'pin', '--scope', 'feature:checkout', '--surface', 'android', '--build', '104', '--reason', 'The only build', '--by', 'dana');
  assert.ok(w.blockerIds().includes('R1:android:104'), 'a pinned build whose smoke failed is not accepted');
});

test('S6-03 NOT_READY when the feature plan is not approved', () => {
  const w = readyFeature();
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'plans', '--value', '"payments/test-plan.md"', '--by', 'dana');
  const r = w.readiness();
  assert.equal(r.verdict, 'NOT_READY');
  assert.ok(w.blockerIds().includes('R2:payments/test-plan.md'));
});

test('S6-04 NOT_READY on any functional FAIL, BLOCKED, NOT_RUN or missing result', () => {
  const w = readyFeature({ run: false });
  functional(w, '104', { 'checkout/TC14': 'fail', 'checkout/EC1': 'blocked', 'checkout/EC-U1': 'not_run', 'checkout/A11Y1': null });
  const ids = w.blockerIds();
  for (const c of ['checkout/TC14', 'checkout/EC1', 'checkout/EC-U1', 'checkout/A11Y1']) assert.ok(ids.includes(`R3:android:${c}`), c);
  assert.ok(!ids.includes('R3:android:checkout/TC1'));
  assert.equal(w.readiness().verdict, 'NOT_READY');
});

test('S6-05 NOT_READY while a linked bug is open', () => {
  const w = readyFeature();
  w.ok('bug', 'report', '--id', 'BUG-3', '--title', 'Typo on receipt', '--step', 's', '--expected', 'e', '--actual', 'a', '--severity', 'minor', '--surfaces', 'android', '--related-scope', 'feature:checkout', '--by', 'dana');
  assert.deepEqual(w.blockerIds(), ['R4:bug:BUG-3']);
  // Blocking bugs must be verified, duplicate or not reproducible — won't-fix is not enough.
  w.ok('bug', 'report', '--id', 'BUG-4', '--title', 'Crash on pay', '--step', 's', '--expected', 'e', '--actual', 'a', '--severity', 'critical', '--surfaces', 'android', '--related-scope', 'feature:checkout', '--by', 'dana');
  w.ok('bug', 'resolve', '--bug', 'bug:BUG-4', '--resolution', 'wont_fix', '--reason', 'Legacy path', '--by', 'lead');
  assert.ok(w.blockerIds().includes('R4:bug:BUG-4'));
  w.ok('bug', 'resolve', '--bug', 'bug:BUG-3', '--resolution', 'wont_fix', '--reason', 'Cosmetic', '--by', 'lead');
  assert.ok(!w.blockerIds().includes('R4:bug:BUG-3'), 'a closed non-blocking bug no longer blocks');
});

test('S6-06 NOT_READY while a fix is delivered but not re-tested — and when the candidate predates the fix', () => {
  const w = bugScope({ retest: null });
  notRequired(w, 'bug:BUG-27');
  assert.deepEqual(w.blockerIds('bug:BUG-27'), ['R5:bug:BUG-27']);
  w.ok('bug', 'retest', '--bug', 'bug:BUG-27', '--build', 'atv-104', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'pass');
  assert.equal(w.readiness('bug:BUG-27').verdict, 'READY');
  // Pinning a candidate older than the fix means the fix is not in what ships.
  smoke(w, 'atv-103', 'android-tv', [], 'bug:BUG-27');
  w.ok('readiness', 'pin', '--scope', 'bug:BUG-27', '--surface', 'android-tv', '--build', 'atv-103', '--reason', 'Hold back', '--by', 'dana');
  assert.ok(w.blockerIds('bug:BUG-27').includes('R5:bug:BUG-27:android-tv'));
});

test('S6-07 NOT_READY without an explicit regression decision', () => {
  const w = readyFeature({ decide: false });
  assert.deepEqual(w.blockerIds(), ['R6']);
});

test('S6-08 NOT_READY until required regression cases PASS on the candidate build', () => {
  const w = readyFeature({ decide: false });
  w.ok('regression', 'decide', '--scope', 'feature:checkout', '--by', 'dana', '--required', 'yes', '--reason', 'Shared cart state', '--case', 'checkout/TC1', '--case', 'checkout/EC1', '--target', '104@android');
  assert.deepEqual(w.blockerIds(), ['R7:104@android:checkout/TC1', 'R7:104@android:checkout/EC1']);
  const run = w.ok('run', 'open', '--type', 'regression', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--decision', 'RD-1').run_id;
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'pass');
  w.ok('result', 'add', '--run', run, '--case', 'checkout/EC1', '--result', 'blocked');
  w.ok('run', 'close', '--run', run);
  assert.deepEqual(w.blockerIds(), ['R7:104@android:checkout/EC1']);
  // A decision that does not target the candidate build never satisfies it.
  w.ok('build', 'add', '--id', '105', '--surfaces', 'android', '--registered-by', 'dana', '--related-scope', 'feature:checkout');
  smoke(w, '105', 'android');
  assert.ok(w.blockerIds().includes('R7:android:target'));
});

test('S6-09 NOT_READY while QA debt is neither discharged nor excepted', () => {
  const w = readyFeature();
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'debt', '--value', '{"id":"HV-1","description":"VoiceOver walkthrough of Payment","owner":"qa"}', '--by', 'dana');
  assert.deepEqual(w.blockerIds(), ['R8:HV-1']);
  const a11y = w.ok('view', 'case-history', '--case', 'checkout/A11Y1').history[0].result_id;
  w.refused('UNKNOWN_RESULT', 'readiness', 'discharge', '--scope', 'feature:checkout', '--debt', 'HV-1', '--result', 'nope/1', '--by', 'dana');
  w.refused('UNKNOWN_DEBT', 'readiness', 'discharge', '--scope', 'feature:checkout', '--debt', 'HV-9', '--result', a11y, '--by', 'dana');
  w.ok('readiness', 'discharge', '--scope', 'feature:checkout', '--debt', 'HV-1', '--result', a11y, '--by', 'dana');
  assert.equal(w.readiness().verdict, 'READY');
  // Only a PASS discharges debt.
  const f = readyFeature({ run: false });
  const r = functional(f, '104', { 'checkout/A11Y1': 'fail' });
  f.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'debt', '--value', '{"id":"HV-1","description":"VoiceOver","owner":"qa"}', '--by', 'dana');
  f.refused('INVALID_VALUE', 'readiness', 'discharge', '--scope', 'feature:checkout', '--debt', 'HV-1', '--result', `${r}/6`, '--by', 'dana');
});

// ---------- exceptions ----------

test('S6-10 READY_WITH_EXCEPTIONS only when every blocker is explicitly excepted', () => {
  const w = readyFeature();
  w.ok('bug', 'report', '--id', 'BUG-3', '--title', 'Typo', '--step', 's', '--expected', 'e', '--actual', 'a', '--severity', 'minor', '--surfaces', 'android', '--related-scope', 'feature:checkout', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'debt', '--value', '{"id":"HV-1","description":"VoiceOver","owner":"qa"}', '--by', 'dana');
  assert.equal(w.readiness().verdict, 'NOT_READY');
  w.ok('readiness', 'except', '--scope', 'feature:checkout', '--item', 'R4:bug:BUG-3', '--kind', 'known_issue', '--reason', 'Cosmetic typo, fixed next sprint', '--approved-by', 'lead');
  assert.equal(w.readiness().verdict, 'NOT_READY', 'one blocker is still unexcepted');
  w.ok('readiness', 'except', '--scope', 'feature:checkout', '--item', 'R8:HV-1', '--kind', 'waived_debt', '--reason', 'VoiceOver pass scheduled after launch', '--approved-by', 'lead');
  const r = w.readiness();
  assert.equal(r.verdict, 'READY_WITH_EXCEPTIONS');
  assert.deepEqual(r.blockers.map((b) => [b.id, b.excepted_by]), [['R4:bug:BUG-3', 'EX-1'], ['R8:HV-1', 'EX-2']]);
  assert.deepEqual(r.known_issues.map((k) => k.item), ['R4:bug:BUG-3']);
});

test('S6-11 an exception requires a reason, S6-12 and an approver — and a real blocker', () => {
  const w = readyFeature({ decide: false });
  const base = ['readiness', 'except', '--scope', 'feature:checkout', '--item', 'R6', '--kind', 'waived_regression'];
  w.refused('MISSING_ARGUMENT', ...base, '--approved-by', 'lead');
  w.refused('MISSING_ARGUMENT', ...base, '--reason', 'Hotfix');
  w.refused('UNKNOWN_BLOCKER', 'readiness', 'except', '--scope', 'feature:checkout', '--item', 'R8:HV-404', '--kind', 'waived_debt', '--reason', 'x', '--approved-by', 'lead');
  w.refused('INVALID_VALUE', 'readiness', 'except', '--scope', 'feature:checkout', '--item', 'R6', '--kind', 'because', '--reason', 'Hotfix', '--approved-by', 'lead');
  w.refused('MANAGED_FIELD', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'exceptions', '--value', '{"id":"EX-1"}', '--by', 'x');
  w.ok(...base, '--reason', 'Hotfix — regression waived by the QA lead', '--approved-by', 'lead');
  const ex = w.ok('view', 'readiness', '--scope', 'feature:checkout').readiness.exceptions[0];
  assert.deepEqual([ex.id, ex.item, ex.kind, ex.reason, ex.approved_by], ['EX-1', 'R6', 'waived_regression', 'Hotfix — regression waived by the QA lead', 'lead']);
  assert.ok(ex.date);
});

// ---------- candidate builds ----------

test('S6-13 a pinned candidate build stays explicit', () => {
  const w = readyFeature();
  w.ok('build', 'add', '--id', '105', '--surfaces', 'android', '--registered-by', 'dana', '--related-scope', 'feature:checkout');
  smoke(w, '105', 'android');
  assert.deepEqual(w.readiness().candidate_builds, [{ surface: 'android', build_id: '105', pinned: false }], 'latest accepted build');
  w.refused('SURFACE_NOT_IN_BUILD', 'readiness', 'pin', '--scope', 'feature:checkout', '--surface', 'ios', '--build', '104', '--reason', 'x', '--by', 'dana');
  w.refused('MISSING_ARGUMENT', 'readiness', 'pin', '--scope', 'feature:checkout', '--surface', 'android', '--build', '104', '--by', 'dana');
  w.ok('readiness', 'pin', '--scope', 'feature:checkout', '--surface', 'android', '--build', '104', '--reason', 'Release branch is cut from 104', '--by', 'dana');
  assert.deepEqual(w.readiness().candidate_builds, [{ surface: 'android', build_id: '104', pinned: true, reason: 'Release branch is cut from 104' }]);
  w.ok('readiness', 'unpin', '--scope', 'feature:checkout', '--surface', 'android', '--reason', 'Ship latest', '--by', 'dana');
  assert.equal(w.readiness().candidate_builds[0].build_id, '105');
});

// ---------- sign-off ----------

function signed() {
  const w = readyFeature();
  const s = w.ok('readiness', 'signoff', '--scope', 'feature:checkout', '--by', 'lead', '--notes', 'All flows verified on Pixel 8').signoff;
  assert.equal(w.ok('view', 'signoffs', '--scope', 'feature:checkout').signoffs[0].status, 'valid');
  return { w, s };
}
const signoffStatus = (w) => w.ok('view', 'signoffs', '--scope', 'feature:checkout').signoffs.at(-1).status;

test('S6-14 changing the candidate build invalidates the sign-off (S6-23 too)', () => {
  const { w } = signed();
  w.ok('build', 'add', '--id', '105', '--surfaces', 'android', '--registered-by', 'dana', '--related-scope', 'feature:checkout');
  assert.equal(signoffStatus(w), 'valid', 'an unsmoked build does not change the candidate');
  smoke(w, '105', 'android');
  assert.equal(w.readiness().candidate_builds[0].build_id, '105');
  assert.equal(signoffStatus(w), 'stale');
  const p = signed().w;
  p.ok('readiness', 'pin', '--scope', 'feature:checkout', '--surface', 'android', '--build', '104', '--reason', 'Pin explicitly', '--by', 'dana');
  assert.equal(signoffStatus(p), 'stale', 'even pinning the same build is a recorded change');
});

test('S6-15 a standalone bug has its own readiness — no plan, no functional rules', () => {
  const w = bugScope();
  notRequired(w, 'bug:BUG-27');
  const r = w.readiness('bug:BUG-27');
  assert.equal(r.verdict, 'READY');
  assert.deepEqual(r.rules.map((x) => [x.rule, x.status]), [
    ['R1', 'pass'], ['R2', 'not_applicable'], ['R3', 'not_applicable'], ['R4', 'pass'], ['R5', 'pass'], ['R6', 'pass'], ['R7', 'not_applicable'], ['R8', 'pass'], ['R9', 'pass'],
  ]);
  assert.deepEqual(r.candidate_builds, [{ surface: 'android-tv', build_id: 'atv-104', pinned: false }]);
  assert.ok(!fs.existsSync(w.ledger('scopes', 'feature')));
  // Still open → blocked by its own state.
  const open = bugScope({ retest: 'fail' });
  notRequired(open, 'bug:BUG-27');
  assert.ok(open.blockerIds('bug:BUG-27').includes('R4:bug:BUG-27'));
});

test('S6-16 a release scope only aggregates its members', () => {
  const w = readyFeature();
  w.ok('bug', 'report', '--id', 'BUG-27', '--title', 'Freeze', '--step', 's', '--expected', 'e', '--actual', 'a', '--severity', 'major', '--surfaces', 'android', '--by', 'dana');
  w.ok('scope', 'create', '--scope', 'release:2.4.0', '--created-by', 'dana');
  w.ok('scope', 'event', '--scope', 'release:2.4.0', '--op', 'add', '--field', 'members', '--value', '"feature:checkout"', '--by', 'dana');
  assert.equal(w.readiness('release:2.4.0').verdict, 'READY');
  w.ok('scope', 'event', '--scope', 'release:2.4.0', '--op', 'add', '--field', 'members', '--value', '"bug:BUG-27"', '--by', 'dana');
  const r = w.readiness('release:2.4.0');
  assert.equal(r.verdict, 'NOT_READY');
  assert.deepEqual(r.members.map((m) => [m.scope, m.verdict]), [['feature:checkout', 'READY'], ['bug:BUG-27', 'NOT_READY']]);
  assert.ok(r.blockers.every((b) => b.member === 'bug:BUG-27'));
  assert.deepEqual(r.tested_builds, ['104']);
  w.refused('RELEASE_AGGREGATION_ONLY', 'readiness', 'signoff', '--scope', 'release:2.4.0', '--by', 'lead');
  w.refused('RELEASE_AGGREGATION_ONLY', 'readiness', 'except', '--scope', 'release:2.4.0', '--item', 'R6', '--kind', 'waiver', '--reason', 'x', '--approved-by', 'lead');
  const empty = workspace();
  empty.ok('init');
  empty.ok('scope', 'create', '--scope', 'release:2.5.0', '--created-by', 'dana');
  assert.equal(empty.readiness('release:2.5.0').verdict, 'NOT_READY', 'a release with no members is not ready');
});

test('S6-17 stale functional evidence blocks until re-executed', () => {
  const w = readyFeature();
  const plan = path.join(w.qa, 'checkout', 'test-plan.md');
  fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace('The confirmation screen appears', 'The receipt screen appears'));
  const b = w.readiness().blockers.find((x) => x.id === 'R3:android:checkout/TC14');
  assert.match(b.message, /stale/);
});

test('S6-18 excluded cases never block', () => {
  const w = readyFeature({ run: false });
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'exclusions', '--value', '{"case_key":"checkout/EC-U1","surface":"android","reason":"Network toggle unavailable on the device farm"}', '--by', 'dana');
  functional(w, '104', { 'checkout/EC-U1': null });
  assert.equal(w.readiness().verdict, 'READY');
});

test('S6-19 automation never blocks and automated evidence counts like manual', () => {
  const w = readyFeature({ run: false });
  fs.mkdirSync(path.join(w.qa, 'automation', 'tests', 'checkout'), { recursive: true });
  fs.writeFileSync(path.join(w.qa, 'automation', 'tests', 'checkout', 'checkout.spec.js'), 'describe("checkout", () => {});\n');
  functional(w, '104', {}, 'automation:wdio');
  const r = w.readiness();
  assert.equal(r.verdict, 'READY');
  assert.ok(!JSON.stringify(r.rules).includes('automation'), 'no automation rule exists');
});

// ---------- sign-off invalidation ----------

test('S6-20 a sign-off goes stale when a bug changes', () => {
  const { w } = signed();
  w.ok('bug', 'report', '--id', 'BUG-3', '--title', 'Typo', '--step', 's', '--expected', 'e', '--actual', 'a', '--severity', 'minor', '--surfaces', 'android', '--related-scope', 'feature:checkout', '--by', 'dana');
  assert.equal(signoffStatus(w), 'stale');
  const view = w.ok('view', 'signoffs').stale;
  assert.deepEqual(view.map((s) => s.scope), ['feature:checkout'], 'stale sign-offs are listed across scopes');
  // A change to a linked bug that leaves the verdict unchanged still invalidates the sign-off.
  w.ok('bug', 'resolve', '--bug', 'bug:BUG-3', '--resolution', 'wont_fix', '--reason', 'Cosmetic', '--by', 'lead');
  assert.equal(w.readiness().verdict, 'READY');
  w.ok('readiness', 'signoff', '--scope', 'feature:checkout', '--by', 'lead');
  assert.equal(signoffStatus(w), 'valid');
  w.ok('scope', 'event', '--scope', 'bug:BUG-3', '--op', 'set', '--field', 'assignee', '--value', '"omer"', '--by', 'dana');
  assert.equal(w.readiness().verdict, 'READY');
  assert.equal(signoffStatus(w), 'stale');
});

test('S6-21 a sign-off goes stale when the regression decision changes', () => {
  const { w } = signed();
  w.ok('regression', 'decide', '--scope', 'feature:checkout', '--by', 'dana', '--required', 'no', '--reason', 'Re-confirmed: still isolated');
  assert.equal(signoffStatus(w), 'stale');
});

test('S6-22 a sign-off goes stale when QA debt changes', () => {
  const { w } = signed();
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'debt', '--value', '{"id":"HV-1","description":"VoiceOver","owner":"qa"}', '--by', 'dana');
  assert.equal(signoffStatus(w), 'stale');
});

test('S6-24 the fingerprint is stable and ignores records the verdict never read', () => {
  const w = readyFeature();
  const a = w.readiness().fingerprint;
  assert.equal(w.readiness().fingerprint, a);
  w.ok('scope', 'create', '--scope', 'feature:wallet', '--created-by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:wallet', '--op', 'add', '--field', 'notes', '--value', '"unrelated"', '--by', 'dana');
  w.ok('build', 'add', '--id', 'ios-1', '--surfaces', 'ios', '--registered-by', 'dana');
  assert.equal(w.readiness().fingerprint, a, 'unrelated scopes and builds do not move it');
  w.ok('readiness', 'signoff', '--scope', 'feature:checkout', '--by', 'lead');
  assert.equal(w.readiness().fingerprint, a, 'the sign-off itself is not an input');
  w.ok('readiness', 'render', '--scope', 'feature:checkout');
  assert.equal(w.readiness().fingerprint, a, 'the generated Markdown is not an input');
});

test('S6-25 the fingerprint changes whenever a consumed source changes', () => {
  const w = readyFeature();
  const seen = new Set([w.readiness().fingerprint]);
  const changes = [
    () => w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'notes', '--value', '"a note"', '--by', 'dana'),
    () => functional(w, '104'),
    () => {
      const plan = path.join(w.qa, 'checkout', 'test-plan.md');
      fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace('Open the cart', 'Open the basket'));
    },
  ];
  for (const change of changes) {
    change();
    const fp = w.readiness().fingerprint;
    assert.ok(!seen.has(fp), 'a consumed change moves the fingerprint');
    seen.add(fp);
  }
});

test('S6-26 the readiness artifact is deterministic and follows the contract', () => {
  const w = readyFeature();
  w.ok('readiness', 'signoff', '--scope', 'feature:checkout', '--by', 'lead', '--notes', 'Checked on Pixel 8');
  const file = path.join(w.qa, 'readiness', 'feature', 'checkout.md');
  const first = fs.readFileSync(file, 'utf8');
  w.ok('readiness', 'render', '--scope', 'feature:checkout');
  assert.equal(fs.readFileSync(file, 'utf8'), first, 'byte-identical on re-render');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(first)[1];
  for (const key of ['qa_readiness_schema: 1', 'scope: feature:checkout', 'verdict: READY', 'blocker_count: 0', 'exception_count: 0', 'fingerprint: sha256:', 'generated_at: ', 'signed_off_by: lead', 'signed_off_date: ', 'signoff_fingerprint: sha256:', 'signoff_status: valid', 'candidate_builds:', '  - android: 104']) assert.ok(fm.includes(key), key);
  for (const h of ['## Per-Surface Matrix', '## Smoke', '## Functional', '## Regression', '## Bugs', '## Retests', '## QA Debt', '## Exceptions', '## Known Issues', '## Tested Builds', '## QA Notes', '## Release Notes Input']) assert.ok(first.includes(h), h);
  assert.ok(first.includes('Checked on Pixel 8'));
  assert.ok(!first.includes(new Date().getUTCFullYear() + '-' + String(new Date().getUTCMonth() + 1).padStart(2, '0') + '-' + String(new Date().getUTCDate()).padStart(2, '0') + 'T') || first.includes('2026-09-25'), 'generated_at comes from the ledger, not the wall clock');
});

test('S6-27 Stage 1–5 behavior is unchanged by readiness', () => {
  const w = readyFeature();
  const before = fs.readFileSync(w.ledger('scopes', 'feature', 'checkout.jsonl'), 'utf8');
  w.readiness();
  w.ok('view', 'signoffs', '--scope', 'feature:checkout');
  assert.equal(fs.readFileSync(w.ledger('scopes', 'feature', 'checkout.jsonl'), 'utf8'), before, 'computing readiness writes nothing');
  assert.equal(w.ok('view', 'execution', '--scope', 'feature:checkout').surfaces[0].summary.pass, 6);
  assert.equal(w.ok('validate').errors.length, 0);
});

test('S6-28 no Release integration exists', () => {
  const w = readyFeature();
  for (const cmd of [['release'], ['prepare-mobile-release'], ['release', 'gate'], ['view', 'release']]) w.refused('UNKNOWN_COMMAND', ...cmd, '--scope', 'feature:checkout');
  for (const name of fs.readdirSync(path.join(PLUGIN_ROOT, 'commands'))) assert.ok(!/release/i.test(name), name);
  const r = JSON.stringify(w.readiness());
  assert.ok(!/release_gate|prepare-mobile-release|REL-QA/.test(r));
});

test('S6-29 signing off NOT_READY is refused; the sign-off records verdict and fingerprint', () => {
  const w = readyFeature({ decide: false });
  w.refused('SIGNOFF_NOT_READY', 'readiness', 'signoff', '--scope', 'feature:checkout', '--by', 'lead');
  notRequired(w);
  const s = w.ok('readiness', 'signoff', '--scope', 'feature:checkout', '--by', 'lead').signoff;
  assert.deepEqual([s.id, s.verdict, s.signed_by, s.notes], ['SO-1', 'READY', 'lead', null]);
  assert.equal(s.fingerprint, w.readiness().fingerprint);
  assert.ok(w.ok('view', 'signoffs', '--scope', 'feature:checkout').signoffs[0].signed_at);
  w.refused('MANAGED_FIELD', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'signoffs', '--value', '{}', '--by', 'x');
});
