// Tests for QA lifecycle Stage 3 — the bug lifecycle — on top of the Stage 1/2
// ledger. Same harness style as the other ledger suites: a throwaway workspace
// per test, the helper driven only through its CLI.
//
// Run: node --test scripts/qa-bugs.test.mjs
// QA_LEDGER_HELPER overrides the helper path (used by qa-ledger.mutation.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(HERE);
const HELPER = process.env.QA_LEDGER_HELPER || path.join(HERE, 'qa-ledger.mjs');
const FIXTURES = path.join(HERE, 'fixtures', 'qa-ledger');
const STAGE3_COMMANDS = ['report-bug', 'verify-bug', 'retest-bug', 'resolve-bug'];

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function workspace({ files = ['checkout/test-plan.md', 'smoke/android/smoke-suite.md', 'smoke/ios/smoke-suite.md'] } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-bugs-test-')));
  const qa = path.join(ws, 'acme-qa');
  const code = path.join(ws, 'acme-app');
  fs.mkdirSync(path.join(qa, '.git'), { recursive: true });
  fs.mkdirSync(path.join(code, '.git'), { recursive: true });
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(qa, f)), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, f), path.join(qa, f));
  }
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 3, 9, 0, 0) + tick++ * 1000).toISOString();
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
  const ledger = (...p) => path.join(qa, 'qa-ledger', ...p);
  const bugView = (id) => ok('view', 'bug', '--bug', `bug:${id}`).bug;
  return { ws, qa, code, cli, ok, refused, ledger, bugView };
}

// feature:checkout on android + ios, builds 103 (smoke passed on android) and one
// closed functional run on 103 with TC14 FAIL, TC1 PASS, EC1 BLOCKED.
function featureWithFailure() {
  const w = workspace();
  w.ok('init');
  w.ok('scope', 'create', '--scope', 'feature:checkout', '--created-by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'plans', '--value', '"checkout/test-plan.md"', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'surfaces', '--value', '["android","ios"]', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'devices', '--value', '[{"surface":"android","device":"Pixel 8","os_runtime":"Android 15"},{"surface":"ios","device":"iPhone 16","os_runtime":"iOS 18.4"}]', '--by', 'dana');
  w.ok('build', 'add', '--id', '103', '--surfaces', 'android,ios', '--registered-by', 'dana', '--related-scope', 'feature:checkout');
  const smoke = w.ok('run', 'open', '--type', 'smoke', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'smoke/android/smoke-suite.md').run_id;
  for (const c of ['smoke/android/S1', 'smoke/android/S2']) w.ok('result', 'add', '--run', smoke, '--case', c, '--result', 'pass');
  w.ok('run', 'close', '--run', smoke);
  const run = w.ok('run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'checkout/test-plan.md').run_id;
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'fail', '--notes', 'Spinner never ends after Pay now', '--evidence', 'evidence/tc14.mp4');
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'pass');
  w.ok('result', 'add', '--run', run, '--case', 'checkout/EC1', '--result', 'blocked');
  w.ok('run', 'close', '--run', run);
  return { ...w, run };
}

function reportFromRun(w, id, extra = []) {
  return w.ok('bug', 'report', '--id', id, '--from-run', w.run, '--case', 'checkout/TC14', '--title', 'Payment spinner never ends', '--severity', 'critical', '--by', 'dana', ...extra).bug;
}

// A standalone bug on Android TV with no feature, plan, spec or Figma.
// Product-level smoke suites exist for the TV and handheld surfaces; no feature plan does.
const SMOKE_SUITES = ['smoke/android-tv/smoke-suite.md', 'smoke/android/smoke-suite.md', 'smoke/ios/smoke-suite.md'];
function standalone({ surfaces = 'android-tv', id = 'BUG-27', files = SMOKE_SUITES } = {}) {
  const w = workspace({ files });
  w.ok('init');
  w.ok('bug', 'report', '--id', id, '--title', 'Player freezes after resume', '--step', 'Start any movie', '--step', 'Press Home, wait 30 seconds, reopen the app', '--expected', 'Playback resumes where it stopped', '--actual', 'The player shows a frozen frame', '--severity', 'major', '--surfaces', surfaces, '--external-ref', 'JIRA-4411', '--by', 'dana');
  return w;
}

const verify = (w, bug, build, outcome, surface = 'android-tv', device = 'Shield') => w.ok('bug', 'verify', '--bug', `bug:${bug}`, '--build', build, '--surface', surface, '--device', device, '--executor', 'dana', '--outcome', outcome);
const retest = (w, bug, build, outcome, surface = 'android-tv', device = 'Shield') => w.ok('bug', 'retest', '--bug', `bug:${bug}`, '--build', build, '--surface', surface, '--device', device, '--executor', 'dana', '--outcome', outcome);
const addBuild = (w, id, surfaces = 'android-tv', fixes = []) => w.ok('build', 'add', '--id', id, '--surfaces', surfaces, '--registered-by', 'omer', ...fixes.flatMap((f) => ['--fixes', f]));

// Runs the Stage 2 smoke suite for (build, surface) — `results` per case, default all pass.
function smokeRun(w, build, surface, results = [], scope = 'bug:BUG-27') {
  const run = w.ok('run', 'open', '--type', 'smoke', '--scope', scope, '--build', build, '--surface', surface, '--device', 'Smoke device', '--executor', 'dana', '--plan', `smoke/${surface}/smoke-suite.md`).run_id;
  const cases = w.ok('view', 'run-cases', '--run', run).cases;
  cases.forEach((c, i) => w.ok('result', 'add', '--run', run, '--case', c.case_key, '--result', results[i] ?? 'pass'));
  w.ok('run', 'close', '--run', run);
  return run;
}
// A delivered fix build that also passed its own smoke on every surface it ships.
function fixBuild(w, id, surfaces, fixes) {
  const out = addBuild(w, id, surfaces, fixes);
  for (const s of surfaces.split(',')) smokeRun(w, id, s);
  return out;
}

// ---------- A. bugs from feature execution ----------

test('S3-01 a feature FAIL stays only a FAIL until QA decides to report a bug', () => {
  const w = featureWithFailure();
  assert.deepEqual(w.ok('view', 'bugs').bugs, []);
  assert.equal(fs.existsSync(w.ledger('scopes', 'bug')), false);
  assert.equal(fs.existsSync(path.join(w.qa, 'bugs')), false);
});

test('S3-02 /report-bug explicitly creates a bug from a failed execution, already reproduced and with Dev', () => {
  const w = featureWithFailure();
  const bug = reportFromRun(w, 'BUG-27');
  assert.equal(bug.state, 'assigned');
  assert.equal(bug.next_action, 'dev_fix');
  assert.equal(bug.origin.kind, 'execution');
  assert.ok(fs.existsSync(path.join(w.qa, 'bugs', 'BUG-27', 'bug.md')));
});

test('S3-03 a bug cannot be reported from a PASS, a BLOCKED, a missing result or an aborted run', () => {
  const w = featureWithFailure();
  const base = ['bug', 'report', '--id', 'BUG-1', '--from-run', w.run, '--title', 't', '--severity', 'minor', '--by', 'dana'];
  w.refused('NOT_A_FAILURE', ...base, '--case', 'checkout/TC1');
  w.refused('NOT_A_FAILURE', ...base, '--case', 'checkout/EC1');
  w.refused('UNKNOWN_RESULT', ...base, '--case', 'checkout/A11Y1');
  const aborted = w.ok('run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'checkout/test-plan.md').run_id;
  w.ok('result', 'add', '--run', aborted, '--case', 'checkout/I18N1', '--result', 'fail');
  w.ok('run', 'abort', '--run', aborted, '--reason', 'Wrong build installed');
  w.refused('RUN_ABORTED', 'bug', 'report', '--id', 'BUG-2', '--from-run', aborted, '--case', 'checkout/I18N1', '--title', 't', '--severity', 'minor', '--by', 'dana');
  assert.deepEqual(w.ok('view', 'bugs').bugs, []);
});

test('S3-04 a bug from execution links the run, result, case, build, surface, device and feature', () => {
  const w = featureWithFailure();
  reportFromRun(w, 'BUG-27');
  const bug = w.bugView('BUG-27');
  const failed = w.ok('view', 'case-history', '--case', 'checkout/TC14').history[0];
  assert.deepEqual(bug.origin, { kind: 'execution', run_id: w.run, result_id: failed.result_id, case_key: 'checkout/TC14' });
  assert.equal(bug.found_in_build, '103');
  assert.deepEqual(bug.surfaces, ['android']);
  assert.deepEqual(bug.devices, [{ surface: 'android', device: 'Pixel 8', os_runtime: 'Android 15' }]);
  assert.deepEqual(bug.linked_cases, ['checkout/TC14']);
  assert.deepEqual(bug.related_scopes, ['feature:checkout']);
  assert.deepEqual(bug.steps, ['Tap "Pay now" with a valid card'], 'reproduction steps default to the failing row');
  assert.equal(bug.expected, 'The confirmation screen appears');
  assert.equal(bug.actual, 'Spinner never ends after Pay now', 'actual defaults to the failing result notes');
  assert.deepEqual(bug.evidence, ['evidence/tc14.mp4']);
  assert.deepEqual(w.ok('view', 'case-bugs', '--case', 'checkout/TC14').bugs.map((b) => b.bug), ['bug:BUG-27']);
});

// ---------- B. standalone bugs ----------

test('S3-05 a standalone bug needs no feature, test plan, spec or Figma', () => {
  const w = standalone({ files: [] });
  const bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'new');
  assert.equal(bug.next_action, 'qa_verify');
  assert.deepEqual(bug.origin, { kind: 'intake' });
  assert.equal(bug.external_ref, 'JIRA-4411');
  assert.equal(bug.found_in_build, null);
  assert.equal(fs.existsSync(w.ledger('scopes', 'feature')), false, 'no fake feature');
  assert.deepEqual(fs.readdirSync(w.qa).filter((n) => n !== '.git').sort(), ['bugs', 'qa-ledger'], 'no plan folder was invented');
  w.refused('MISSING_ARGUMENT', 'bug', 'report', '--id', 'BUG-9', '--title', 't', '--expected', 'e', '--actual', 'a', '--severity', 'minor', '--surfaces', 'ios', '--by', 'dana');
  w.refused('INVALID_VALUE', 'bug', 'report', '--id', 'BUG-9', '--title', 't', '--step', 's', '--expected', 'e', '--actual', 'a', '--severity', 'blocker', '--surfaces', 'ios', '--by', 'dana');
  w.refused('DUPLICATE_SCOPE', 'bug', 'report', '--id', 'bug-27', '--title', 't', '--step', 's', '--expected', 'e', '--actual', 'a', '--severity', 'minor', '--surfaces', 'ios', '--by', 'dana');
});

test('S3-06 a standalone bug owns a stable repro / re-test case bug:<id>#R1', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  const v = verify(w, 'BUG-27', 'atv-103', 'reproduced');
  const cases = w.ok('view', 'run-cases', '--run', v.run_id).cases;
  assert.deepEqual(cases.map((c) => c.case_key), ['bug:BUG-27#R1']);
  const history = w.ok('view', 'case-history', '--case', 'bug:BUG-27#R1').history;
  assert.equal(history.length, 1);
  assert.equal(history[0].result, 'fail', 'REPRODUCED means the expected behavior failed');
  assert.equal(history[0].case_ref.kind, 'scope_case');
  w.refused('INVALID_VALUE', 'scope', 'event', '--scope', 'bug:BUG-27', '--op', 'add', '--field', 'cases', '--value', '{"id":"R1","summary":"shadow"}', '--by', 'dana');
  // Auto-generated QA-owned ids are deterministic and stable.
  const g = w.ok('bug', 'report', '--title', 'Subtitle overlaps', '--step', 'Enable subtitles', '--expected', 'Subtitles sit above the controls', '--actual', 'They overlap', '--severity', 'minor', '--surfaces', 'android-tv', '--by', 'dana').bug;
  assert.match(g.bug, /^bug:QA-\d{8}-[0-9a-f]{6}$/);
});

test('S3-07 REPRODUCED moves a standalone bug to Dev', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  const bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'assigned');
  assert.equal(bug.next_action, 'dev_fix');
  assert.equal(bug.found_in_build, 'atv-103');
  w.refused('BUG_NOT_AWAITING_VERIFICATION', 'bug', 'verify', '--bug', 'bug:BUG-27', '--build', 'atv-103', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'reproduced');
});

test('S3-08 NOT_REPRODUCIBLE closes the bug with that resolution', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'not_reproducible');
  const bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'closed_not_reproducible');
  assert.equal(bug.next_action, 'none');
  w.refused('BUG_CLOSED', 'bug', 'verify', '--bug', 'bug:BUG-27', '--build', 'atv-103', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'reproduced');
  w.refused('BUG_CLOSED', 'build', 'add', '--id', 'atv-104', '--surfaces', 'android-tv', '--registered-by', 'omer', '--fixes', 'bug:BUG-27');
});

test('S3-09 BLOCKED keeps the verification history and stays retryable', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'blocked');
  assert.equal(w.bugView('BUG-27').state, 'verification_blocked');
  assert.equal(w.bugView('BUG-27').next_action, 'qa_verify');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  const bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'assigned');
  assert.deepEqual(bug.reproductions.map((r) => [r.build_id, r.outcome]), [
    ['atv-103', 'blocked'],
    ['atv-103', 'reproduced'],
  ]);
  w.refused('BUG_SURFACE_MISMATCH', 'bug', 'verify', '--bug', 'bug:BUG-27', '--build', 'atv-103', '--surface', 'ios', '--device', 'iPhone', '--executor', 'dana', '--outcome', 'blocked');
});

// ---------- fix builds and re-tests ----------

test('S3-10 a build can claim to fix a bug — and only a bug that Dev owns', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  w.refused('BUG_NOT_REPRODUCED', 'build', 'add', '--id', 'atv-104', '--surfaces', 'android-tv', '--registered-by', 'omer', '--fixes', 'bug:BUG-27');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  w.refused('FIX_SURFACE_MISMATCH', 'build', 'add', '--id', 'ios-1', '--surfaces', 'ios', '--registered-by', 'omer', '--fixes', 'bug:BUG-27');
  w.refused('UNKNOWN_SCOPE', 'build', 'add', '--id', 'atv-104', '--surfaces', 'android-tv', '--registered-by', 'omer', '--fixes', 'bug:BUG-404');
  w.refused('INVALID_BUG_REF', 'build', 'add', '--id', 'atv-104', '--surfaces', 'android-tv', '--registered-by', 'omer', '--fixes', 'feature:x');
  const build = addBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']).build;
  assert.deepEqual(build.fixes_claimed, ['bug:BUG-27']);
  assert.deepEqual(w.bugView('BUG-27').fix_claims.map((c) => [c.build_id, c.outcome]), [['atv-104', 'pending']]);
});

test('S3-11 a fix claim never closes a bug on its own', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  addBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  const bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'fix_delivered');
  assert.equal(bug.next_action, 'qa_retest');
  assert.equal(bug.current_fix_build, 'atv-104');
  assert.equal(bug.fixed_in_build, null);
  assert.deepEqual(bug.pending_retest_surfaces, ['android-tv']);
});

test('S3-12 a re-test PASS closes the bug only once every affected surface passed', () => {
  const w = standalone({ surfaces: 'android,ios' });
  addBuild(w, '103', 'android,ios');
  verify(w, 'BUG-27', '103', 'reproduced', 'android', 'Pixel 8');
  fixBuild(w, '104', 'android,ios', ['bug:BUG-27']);
  retest(w, 'BUG-27', '104', 'pass', 'android', 'Pixel 8');
  let bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'fix_delivered', 'ios has not been re-tested yet');
  assert.deepEqual(bug.pending_retest_surfaces, ['ios']);
  retest(w, 'BUG-27', '104', 'blocked', 'ios', 'iPhone 16');
  assert.equal(w.bugView('BUG-27').state, 'fix_delivered', 'BLOCKED never closes');
  retest(w, 'BUG-27', '104', 'pass', 'ios', 'iPhone 16');
  bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'closed_verified');
  assert.equal(bug.resolution, 'verified');
  assert.equal(bug.fixed_in_build, '104');
  assert.equal(bug.next_action, 'none');
  w.refused('BUG_CLOSED', 'bug', 'retest', '--bug', 'bug:BUG-27', '--build', '104', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--outcome', 'pass');
});

test('S3-13 a re-test FAIL reopens the bug', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  fixBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  retest(w, 'BUG-27', 'atv-104', 'fail');
  const bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'reopened');
  assert.deepEqual(bug.fix_claims.map((c) => [c.build_id, c.outcome]), [['atv-104', 'failed']]);
});

test('S3-14 after a reopen the next action is Dev, not another QA re-test', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  fixBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  retest(w, 'BUG-27', 'atv-104', 'fail');
  const bug = w.bugView('BUG-27');
  assert.equal(bug.next_action, 'dev_fix');
  assert.equal(bug.current_fix_build, null, 'the failed fix is no longer the fix under test');
  assert.deepEqual(bug.pending_retest_surfaces, []);
});

test('S3-15 the same failed fix build cannot be re-tested as a new fix cycle', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  fixBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  retest(w, 'BUG-27', 'atv-104', 'blocked');
  retest(w, 'BUG-27', 'atv-104', 'fail');
  w.refused('BUG_AWAITING_FIX', 'bug', 'retest', '--bug', 'bug:BUG-27', '--build', 'atv-104', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'pass');
  addBuild(w, 'atv-105', 'android-tv', ['bug:BUG-27']);
  w.refused('RETEST_BUILD_BEFORE_FIX', 'bug', 'retest', '--bug', 'bug:BUG-27', '--build', 'atv-104', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'pass');
  w.refused('RETEST_BUILD_BEFORE_FIX', 'bug', 'retest', '--bug', 'bug:BUG-27', '--build', 'atv-103', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'pass');
});

test('S3-16 a newer fix build can be re-tested and closes the bug', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  fixBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  retest(w, 'BUG-27', 'atv-104', 'fail');
  fixBuild(w, 'atv-105', 'android-tv', ['bug:BUG-27']);
  retest(w, 'BUG-27', 'atv-105', 'pass');
  const bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'closed_verified');
  assert.equal(bug.fixed_in_build, 'atv-105');
});

test('S3-17 repeated FAIL → fix → FAIL → fix → PASS cycles stay fully preserved', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  for (const [build, outcome] of [['atv-104', 'fail'], ['atv-105', 'fail'], ['atv-106', 'pass']]) {
    fixBuild(w, build, 'android-tv', ['bug:BUG-27']);
    retest(w, 'BUG-27', build, outcome);
  }
  const bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'closed_verified');
  assert.deepEqual(bug.fix_claims.map((c) => [c.build_id, c.outcome]), [
    ['atv-104', 'failed'],
    ['atv-105', 'failed'],
    ['atv-106', 'verified'],
  ]);
  assert.deepEqual(bug.retests.map((r) => [r.build_id, r.outcome, r.fix_build]), [
    ['atv-104', 'fail', 'atv-104'],
    ['atv-105', 'fail', 'atv-105'],
    ['atv-106', 'pass', 'atv-106'],
  ]);
  assert.deepEqual(bug.history.map((h) => h.event), ['reported', 'reproduction', 'fix_claimed', 'retest', 'reopened', 'fix_claimed', 'retest', 'reopened', 'fix_claimed', 'retest', 'closed']);
  assert.deepEqual(w.ok('view', 'case-history', '--case', 'bug:BUG-27#R1').history.map((h) => [h.type, h.build_id, h.result]), [
    ['reproduction', 'atv-103', 'fail'],
    ['retest', 'atv-104', 'fail'],
    ['retest', 'atv-105', 'fail'],
    ['retest', 'atv-106', 'pass'],
  ]);
  assert.equal(w.ok('validate').errors.length, 0);
});

// ---------- links ----------

test('S3-18 one bug links several test cases', () => {
  const w = featureWithFailure();
  reportFromRun(w, 'BUG-27', ['--linked-case', 'checkout/EC1']);
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'add', '--field', 'linked_cases', '--value', '"checkout/I18N1"', '--by', 'dana');
  w.refused('UNKNOWN_CASE', 'scope', 'event', '--scope', 'bug:BUG-27', '--op', 'add', '--field', 'linked_cases', '--value', '"checkout/TC999"', '--by', 'dana');
  w.refused('UNKNOWN_CASE', 'bug', 'report', '--id', 'BUG-3', '--from-run', w.run, '--case', 'checkout/TC14', '--linked-case', 'nope/TC1', '--title', 't', '--severity', 'minor', '--by', 'dana');
  assert.deepEqual(w.bugView('BUG-27').linked_cases, ['checkout/TC14', 'checkout/EC1', 'checkout/I18N1']);
  assert.deepEqual(w.ok('view', 'case-bugs', '--case', 'checkout/I18N1').bugs.map((b) => b.bug), ['bug:BUG-27']);
});

test('S3-19 one test case can expose several bugs', () => {
  const w = featureWithFailure();
  reportFromRun(w, 'BUG-27');
  w.ok('bug', 'report', '--id', 'BUG-28', '--from-run', w.run, '--case', 'checkout/TC14', '--title', 'Pay now charges twice', '--severity', 'critical', '--actual', 'Two charges appear', '--by', 'dana');
  const bugs = w.ok('view', 'case-bugs', '--case', 'checkout/TC14').bugs;
  assert.deepEqual(bugs.map((b) => [b.bug, b.state]), [
    ['bug:BUG-27', 'assigned'],
    ['bug:BUG-28', 'assigned'],
  ]);
});

// ---------- close / resolution ----------

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const seal = ({ hash, ...rest }) => ({ ...rest, hash: `sha256:${sha256(canonical(rest))}` });
const readStream = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const writeStream = (f, recs) => fs.writeFileSync(f, recs.map(canonical).join('\n') + '\n');

test('S3-20 closed_verified needs real re-test evidence', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  w.refused('INVALID_VALUE', 'bug', 'resolve', '--bug', 'bug:BUG-27', '--resolution', 'verified', '--reason', 'Dev says fixed', '--by', 'dana');
  w.refused('BUG_AWAITING_FIX', 'bug', 'retest', '--bug', 'bug:BUG-27', '--build', 'atv-103', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'pass');
  addBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  w.refused('INVALID_VALUE', 'bug', 'retest', '--bug', 'bug:BUG-27', '--build', 'atv-104', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'not_run');
  assert.equal(w.bugView('BUG-27').state, 'fix_delivered');

  // A hand-written "verified" resolution is not a re-test and is rejected by validate.
  const f = w.ledger('scopes', 'bug', 'BUG-27.jsonl');
  const recs = readStream(f);
  const last = recs[recs.length - 1];
  recs.push(seal({ v: 1, seq: last.seq + 1, prev: last.hash, at: '2026-09-04T00:00:00.000Z', kind: 'bug.resolved', resolution: 'verified', reason: 'x', reference: null, by: 'eve' }));
  writeStream(f, recs);
  const codes = w.cli('validate').json.errors.map((e) => e.code);
  assert.ok(codes.includes('INVALID_RECORD'), codes);
});

test('S3-21 duplicate and wont_fix need a human decision with a reason', () => {
  const w = standalone();
  w.ok('bug', 'report', '--id', 'BUG-28', '--title', 'Same freeze', '--step', 's', '--expected', 'e', '--actual', 'a', '--severity', 'major', '--surfaces', 'android-tv', '--by', 'dana');
  w.refused('MISSING_ARGUMENT', 'bug', 'resolve', '--bug', 'bug:BUG-28', '--resolution', 'duplicate', '--by', 'dana');
  w.refused('MISSING_ARGUMENT', 'bug', 'resolve', '--bug', 'bug:BUG-28', '--resolution', 'duplicate', '--reason', 'same freeze');
  w.refused('UNKNOWN_SCOPE', 'bug', 'resolve', '--bug', 'bug:BUG-28', '--resolution', 'duplicate', '--reason', 'same freeze', '--reference', 'bug:BUG-404', '--by', 'dana');
  w.refused('INVALID_VALUE', 'bug', 'resolve', '--bug', 'bug:BUG-28', '--resolution', 'duplicate', '--reason', 'same freeze', '--reference', 'bug:BUG-28', '--by', 'dana');
  w.ok('bug', 'resolve', '--bug', 'bug:BUG-28', '--resolution', 'duplicate', '--reason', 'Same freeze as BUG-27', '--reference', 'bug:BUG-27', '--by', 'dana');
  let bug = w.bugView('BUG-28');
  assert.equal(bug.state, 'closed_duplicate');
  assert.deepEqual([bug.resolution, bug.resolution_reason, bug.resolution_reference, bug.resolved_by], ['duplicate', 'Same freeze as BUG-27', 'bug:BUG-27', 'dana']);
  w.refused('BUG_CLOSED', 'bug', 'resolve', '--bug', 'bug:BUG-28', '--resolution', 'wont_fix', '--reason', 'x', '--by', 'dana');
  w.ok('bug', 'resolve', '--bug', 'bug:BUG-27', '--resolution', 'wont_fix', '--reason', 'Legacy player is being replaced in Q1', '--reference', 'PROD-12', '--by', 'lead');
  bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'closed_wont_fix');
  assert.equal(bug.next_action, 'none');
});

// ---------- markdown view ----------

test('S3-22 bug.md is derived from the ledger and never authoritative', () => {
  const w = standalone();
  const md = path.join(w.qa, 'bugs', 'BUG-27', 'bug.md');
  let text = fs.readFileSync(md, 'utf8');
  assert.match(text, /Generated from the QA ledger/);
  for (const needle of ['Player freezes after resume', 'major', 'new', 'QA: verify', 'android-tv', 'JIRA-4411']) assert.ok(text.includes(needle), needle);

  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  fixBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  retest(w, 'BUG-27', 'atv-104', 'fail');
  text = fs.readFileSync(md, 'utf8');
  for (const needle of ['reopened', 'Dev: fix', 'atv-104', '## Re-test History', '## Reproduction History']) assert.ok(text.includes(needle), needle);

  // Hand-editing the view changes nothing in the ledger, and render restores it.
  fs.writeFileSync(md, text.replace('reopened', 'closed_verified'));
  assert.equal(w.bugView('BUG-27').state, 'reopened');
  assert.equal(w.ok('validate').errors.length, 0);
  w.ok('bug', 'render', '--bug', 'bug:BUG-27');
  assert.equal(fs.readFileSync(md, 'utf8'), text);
  assert.ok(!fs.readdirSync(w.ledger()).includes('bugs'), 'the view lives outside the ledger');
});

// ---------- preservation ----------

test('S3-23 feature execution and smoke behave exactly as before', () => {
  const w = featureWithFailure();
  reportFromRun(w, 'BUG-27');
  const tc14 = w.ok('view', 'execution', '--scope', 'feature:checkout', '--surface', 'android').surfaces[0].cases.find((c) => c.case_key === 'checkout/TC14');
  assert.equal(tc14.status, 'fail', 'reporting a bug never rewrites the failed result');
  assert.deepEqual(tc14.latest.bug_refs, []);
  w.refused('SMOKE_GATE_CLOSED', 'run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'ios', '--device', 'iPhone 16', '--executor', 'dana', '--plan', 'checkout/test-plan.md');
  // A fix build still needs its own smoke before feature execution on it.
  w.ok('build', 'add', '--id', '104', '--surfaces', 'android,ios', '--registered-by', 'omer', '--related-scope', 'feature:checkout', '--fixes', 'bug:BUG-27');
  w.refused('SMOKE_GATE_CLOSED', 'run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'checkout/test-plan.md');
  assert.equal(w.ok('validate').errors.length, 0);
});

function sources() {
  const files = [path.join(HERE, 'qa-ledger.mjs')];
  const lib = path.join(HERE, 'lib', 'qa-ledger');
  for (const f of fs.readdirSync(lib)) files.push(path.join(lib, f));
  return files.map((f) => [path.relative(PLUGIN_ROOT, f), fs.readFileSync(f, 'utf8')]);
}

test('S3-24 no Project Knowledge is consumed', () => {
  const w = standalone();
  fs.mkdirSync(path.join(w.code, '.ono'));
  fs.writeFileSync(path.join(w.code, '.ono', 'repo-knowledge.json'), '{"capabilities":[{"id":"playback"}]}');
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'set', '--field', 'capability', '--value', '"playback"', '--by', 'dana');
  assert.equal(w.bugView('BUG-27').capability, 'playback', 'capability is a QA-entered reference only');
  for (const [file, text] of sources()) for (const needle of ['repo-knowledge', 'docs/project', 'capabilityRelationships']) assert.ok(!text.includes(needle), `${file}: ${needle}`);
  for (const c of STAGE3_COMMANDS) assert.ok(!/repo-knowledge|docs\/project/.test(fs.readFileSync(path.join(PLUGIN_ROOT, 'commands', `${c}.md`), 'utf8')), c);
});

test('S3-25 no regression, readiness or release logic exists yet', () => {
  const w = standalone();
  for (const cmd of [['regression'], ['readiness'], ['signoff'], ['release'], ['view', 'readiness'], ['view', 'regression']]) w.refused('UNKNOWN_COMMAND', ...cmd, '--bug', 'bug:BUG-27');
  for (const name of fs.readdirSync(path.join(PLUGIN_ROOT, 'commands'))) assert.ok(!/regression|readiness|sign-?off|release/i.test(name), name);
  const view = JSON.stringify(w.ok('view', 'bug', '--bug', 'bug:BUG-27'));
  assert.ok(!/READY|verdict|blocking/i.test(view), 'severity is recorded, never turned into a readiness decision');
});

// ---------- structural guarantees ----------

test('S3-26 validate re-derives every transition, so a forged re-test is caught', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  fixBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  const good = retest(w, 'BUG-27', 'atv-104', 'fail').run_id;
  assert.equal(w.ok('validate').errors.length, 0);
  // A second, well-sealed re-test on the failed fix build, written by hand.
  const recs = readStream(w.ledger('runs', `${good}.jsonl`));
  const forged = good.replace(/-[0-9a-f]{8}$/, '-0badf00d');
  const out = [];
  for (const r of recs) {
    const copy = { ...r, prev: out.length ? out[out.length - 1].hash : null, at: '2026-09-05T00:00:00.000Z' };
    if (copy.kind === 'run.opened') copy.run_id = forged;
    if (copy.result_id) copy.result_id = copy.result_id.replace(good, forged);
    if (copy.kind === 'result.recorded') copy.result = 'pass';
    out.push(seal(copy));
  }
  writeStream(w.ledger('runs', `${forged}.jsonl`), out);
  const codes = w.cli('validate').json.errors.map((e) => e.code);
  assert.ok(codes.includes('INVALID_TRANSITION'), codes);
});

test('S3-27 verify/retest write one atomic run; the generic run path obeys the same rules', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  const v = verify(w, 'BUG-27', 'atv-103', 'blocked');
  const recs = readStream(w.ledger('runs', `${v.run_id}.jsonl`));
  assert.deepEqual(recs.map((r) => r.kind), ['run.opened', 'result.recorded', 'run.closed']);
  assert.equal(recs[0].execution_type, 'reproduction');

  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'add', '--field', 'cases', '--value', '{"id":"R2","summary":"Resume after a phone call"}', '--by', 'dana');
  const run = w.ok('run', 'open', '--type', 'reproduction', '--scope', 'bug:BUG-27', '--build', 'atv-103', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana').run_id;
  assert.deepEqual(w.ok('view', 'run-cases', '--run', run).remaining, ['bug:BUG-27#R1', 'bug:BUG-27#R2']);
  w.ok('result', 'add', '--run', run, '--case', 'bug:BUG-27#R2', '--result', 'pass');
  w.refused('BUG_OUTCOME_REQUIRED', 'run', 'close', '--run', run);
  w.refused('INVALID_VALUE', 'result', 'add', '--run', run, '--case', 'bug:BUG-27#R1', '--result', 'not_run');
  w.ok('result', 'add', '--run', run, '--case', 'bug:BUG-27#R1', '--result', 'fail');
  w.ok('run', 'close', '--run', run);
  assert.equal(w.bugView('BUG-27').state, 'assigned');
  w.refused('BUG_NOT_AWAITING_VERIFICATION', 'run', 'open', '--type', 'reproduction', '--scope', 'bug:BUG-27', '--build', 'atv-103', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana');
  w.refused('BUG_AWAITING_FIX', 'run', 'open', '--type', 'retest', '--scope', 'bug:BUG-27', '--build', 'atv-103', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana');
});

test('S3-28 bug views list current state, next action and the case → bug map', () => {
  const w = featureWithFailure();
  reportFromRun(w, 'BUG-27');
  w.ok('bug', 'report', '--id', 'BUG-30', '--title', 'Crash on logout', '--step', 'Log out', '--expected', 'Login screen', '--actual', 'Crash', '--severity', 'major', '--surfaces', 'ios', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'set', '--field', 'assignee', '--value', '"omer"', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'set', '--field', 'severity', '--value', '"major"', '--by', 'dana');
  w.refused('INVALID_VALUE', 'scope', 'event', '--scope', 'bug:BUG-27', '--op', 'set', '--field', 'severity', '--value', '"urgent"', '--by', 'dana');
  const list = w.ok('view', 'bugs').bugs;
  assert.deepEqual(list.map((b) => [b.bug, b.state, b.next_action, b.severity]), [
    ['bug:BUG-27', 'assigned', 'dev_fix', 'major'],
    ['bug:BUG-30', 'new', 'qa_verify', 'major'],
  ]);
  assert.deepEqual(w.ok('view', 'bugs', '--scope', 'feature:checkout').bugs.map((b) => b.bug), ['bug:BUG-27']);
  assert.deepEqual(w.ok('view', 'bugs', '--state', 'new').bugs.map((b) => b.bug), ['bug:BUG-30']);
  assert.equal(w.bugView('BUG-27').assignee, 'omer');
  const history = w.bugView('BUG-27').history.map((h) => h.event);
  assert.deepEqual(history, ['reported', 'assignee_set', 'severity_set']);
});


// ---------- re-tests respect the Stage 2 smoke gate ----------

const retestArgs = (bug, build, surface = 'android-tv', device = 'Shield') => ['bug', 'retest', '--bug', `bug:${bug}`, '--build', build, '--surface', surface, '--device', device, '--executor', 'dana', '--outcome', 'pass'];

test('S3-29 a standalone bug re-test on a fix build with no smoke is refused', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  addBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  const r = w.refused('SMOKE_GATE_CLOSED', ...retestArgs('BUG-27', 'atv-104'));
  assert.equal(r.error.details.smoke_status, 'not_started');
  assert.equal(w.bugView('BUG-27').state, 'fix_delivered', 'the refused re-test changed nothing');
  assert.deepEqual(w.bugView('BUG-27').retests, []);
});

test('S3-30 a feature-originated bug re-test on a fix build with no smoke is refused', () => {
  const w = featureWithFailure();
  reportFromRun(w, 'BUG-27');
  w.ok('build', 'add', '--id', '104', '--surfaces', 'android,ios', '--registered-by', 'omer', '--related-scope', 'feature:checkout', '--fixes', 'bug:BUG-27');
  const r = w.refused('SMOKE_GATE_CLOSED', ...retestArgs('BUG-27', '104', 'android', 'Pixel 8'));
  assert.equal(r.error.details.smoke_status, 'not_started', 'the smoke that passed on build 103 does not carry over');
  smokeRun(w, '104', 'android', [], 'feature:checkout');
  w.ok(...retestArgs('BUG-27', '104', 'android', 'Pixel 8'));
  assert.equal(w.bugView('BUG-27').state, 'closed_verified', 'smoke is build-level: the feature scope ran it, the bug re-test uses it');
});

test('S3-31 a smoke FAIL on the fix build refuses the re-test', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  addBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  smokeRun(w, 'atv-104', 'android-tv', ['pass', 'fail']);
  assert.equal(w.refused('SMOKE_GATE_CLOSED', ...retestArgs('BUG-27', 'atv-104')).error.details.smoke_status, 'failed');
});

test('S3-32 a smoke BLOCKED (or incomplete) on the fix build refuses the re-test', () => {
  const w = standalone({ surfaces: 'android-tv,android' });
  addBuild(w, 'atv-103', 'android-tv,android');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  addBuild(w, 'atv-104', 'android-tv,android', ['bug:BUG-27']);
  smokeRun(w, 'atv-104', 'android-tv', ['blocked', 'pass']);
  smokeRun(w, 'atv-104', 'android', ['pass', 'not_run']);
  assert.equal(w.refused('SMOKE_GATE_CLOSED', ...retestArgs('BUG-27', 'atv-104')).error.details.smoke_status, 'blocked');
  assert.equal(w.refused('SMOKE_GATE_CLOSED', ...retestArgs('BUG-27', 'atv-104', 'android', 'Pixel 8')).error.details.smoke_status, 'incomplete');
});

test('S3-33 a smoke PASS on the fix build allows the re-test', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  addBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  smokeRun(w, 'atv-104', 'android-tv');
  w.ok(...retestArgs('BUG-27', 'atv-104'));
  assert.equal(w.bugView('BUG-27').state, 'closed_verified');
});

test('S3-34 an explicit Stage 2 smoke override allows the re-test and leaves the smoke result as it was', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  addBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  smokeRun(w, 'atv-104', 'android-tv', ['pass', 'fail']);
  w.refused('SMOKE_GATE_CLOSED', ...retestArgs('BUG-27', 'atv-104'));
  const reason = 'S2 fails on the home rows only; playback resume is unaffected — QA lead approved';
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'add', '--field', 'smoke_overrides', '--value', JSON.stringify({ build_id: 'atv-104', surface: 'android-tv', reason }), '--by', 'dana');
  w.ok(...retestArgs('BUG-27', 'atv-104'));
  assert.equal(w.bugView('BUG-27').state, 'closed_verified');
  const smoke = w.ok('view', 'smoke', '--build', 'atv-104', '--surface', 'android-tv').surfaces[0];
  assert.equal(smoke.status, 'failed', 'the override never rewrites smoke');
  assert.deepEqual(smoke.overrides, [{ scope: 'bug:BUG-27', reason, by: 'dana' }]);
  assert.equal(w.ok('validate').errors.length, 0);
});

test('S3-35 each new fix build needs its own smoke — the previous build’s smoke never carries forward', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  fixBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  retest(w, 'BUG-27', 'atv-104', 'fail');
  addBuild(w, 'atv-105', 'android-tv', ['bug:BUG-27']);
  assert.equal(w.refused('SMOKE_GATE_CLOSED', ...retestArgs('BUG-27', 'atv-105')).error.details.smoke_status, 'not_started');
  smokeRun(w, 'atv-105', 'android-tv');
  w.ok(...retestArgs('BUG-27', 'atv-105'));
  assert.equal(w.bugView('BUG-27').fixed_in_build, 'atv-105');
});

test('S3-36 reproduction before a fix is not smoke-gated', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'blocked');
  smokeRun(w, 'atv-103', 'android-tv', ['fail', 'pass']);
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  assert.deepEqual(w.bugView('BUG-27').reproductions.map((r) => r.outcome), ['blocked', 'reproduced'], 'reproduction ran with no smoke, and again on a build whose smoke failed');
});

test('S3-37 validate re-derives the smoke gate for every re-test', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  fixBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  const good = retest(w, 'BUG-27', 'atv-104', 'blocked').run_id;
  addBuild(w, 'atv-105', 'android-tv');
  assert.equal(w.ok('validate').errors.length, 0);
  // The same re-test, hand-moved to build atv-105, which never had smoke.
  const recs = readStream(w.ledger('runs', `${good}.jsonl`));
  const forged = good.replace(/-[0-9a-f]{8}$/, '-0badf00d');
  const out = [];
  for (const r of recs) {
    const copy = { ...r, prev: out.length ? out[out.length - 1].hash : null, at: '2026-09-05T00:00:00.000Z' };
    if (copy.kind === 'run.opened') Object.assign(copy, { run_id: forged, build_id: 'atv-105' });
    if (copy.result_id) copy.result_id = copy.result_id.replace(good, forged);
    out.push(seal(copy));
  }
  writeStream(w.ledger('runs', `${forged}.jsonl`), out);
  const codes = w.cli('validate').json.errors.map((e) => e.code);
  assert.ok(codes.includes('GATE_NOT_HELD'), codes);
});

// ---------- a later fix claim supersedes a pending one ----------

test('S3-38 a later fix claim supersedes the pending one; the earlier claim stays in history', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  fixBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  assert.equal(w.bugView('BUG-27').current_fix_build, 'atv-104');
  const claim104 = fs.readFileSync(w.ledger('builds', 'atv-104.json'));

  // Before QA re-tests 104, Dev delivers 105 claiming the same fix.
  addBuild(w, 'atv-105', 'android-tv', ['bug:BUG-27']);
  let bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'fix_delivered');
  assert.equal(bug.current_fix_build, 'atv-105', 'the later claim is the fix under test');
  assert.deepEqual(bug.fix_claims.map((c) => [c.build_id, c.outcome]), [
    ['atv-104', 'superseded'],
    ['atv-105', 'pending'],
  ]);
  assert.deepEqual(fs.readFileSync(w.ledger('builds', 'atv-104.json')), claim104, 'the 104 claim itself is never rewritten');

  // 104 — even though its smoke passed — is no longer the fix under test.
  const r = w.refused('FIX_CLAIM_SUPERSEDED', ...retestArgs('BUG-27', 'atv-104'));
  assert.match(r.error.message, /atv-105/);
  // 105 needs its own smoke before its re-test.
  w.refused('SMOKE_GATE_CLOSED', ...retestArgs('BUG-27', 'atv-105'));
  smokeRun(w, 'atv-105', 'android-tv');
  w.ok(...retestArgs('BUG-27', 'atv-105'));
  bug = w.bugView('BUG-27');
  assert.equal(bug.state, 'closed_verified');
  assert.equal(bug.fixed_in_build, 'atv-105');
  assert.deepEqual(bug.fix_claims.map((c) => [c.build_id, c.outcome]), [
    ['atv-104', 'superseded'],
    ['atv-105', 'verified'],
  ]);
  assert.deepEqual(bug.history.filter((h) => h.event === 'fix_claimed').map((h) => h.detail), ['build atv-104', 'build atv-105']);
  assert.equal(w.ok('validate').errors.length, 0);
});

test('S3-39 a smoke run in a bug scope records only its suite, never the bug scenario', () => {
  const w = standalone();
  addBuild(w, 'atv-103');
  verify(w, 'BUG-27', 'atv-103', 'reproduced');
  addBuild(w, 'atv-104', 'android-tv', ['bug:BUG-27']);
  const run = w.ok('run', 'open', '--type', 'smoke', '--scope', 'bug:BUG-27', '--build', 'atv-104', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--plan', 'smoke/android-tv/smoke-suite.md').run_id;
  assert.deepEqual(w.ok('view', 'run-cases', '--run', run).remaining, ['smoke/android-tv/S1', 'smoke/android-tv/S2']);
  w.refused('UNKNOWN_CASE', 'result', 'add', '--run', run, '--case', 'bug:BUG-27#R1', '--result', 'pass');
  assert.deepEqual(w.ok('view', 'case-history', '--case', 'bug:BUG-27#R1').history.map((h) => h.type), ['reproduction'], 'smoke never becomes bug evidence');
});
