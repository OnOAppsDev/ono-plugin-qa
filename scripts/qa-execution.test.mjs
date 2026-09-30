// Tests for QA lifecycle Stage 2 — feature execution + smoke — on top of the
// Stage 1 ledger (scripts/qa-ledger.mjs). Same harness style as qa-ledger.test.mjs:
// a throwaway workspace per test, the helper driven only through its CLI.
//
// Run: node --test scripts/qa-execution.test.mjs
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
const STAGE2_COMMANDS = ['register-build', 'set-qa-scope', 'define-smoke-suite', 'record-execution'];
// check-qa-coverage is left out since Stage 4, which binds the Dev handoff into the ledger through it.
const PLANNING_COMMANDS = ['create-qa-test-plan', 'sync-qa-test-plan', 'approve-qa-test-plan', 'generate-automation-scripts', 'verify-automation-locators'];

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function workspace({ smoke = ['android', 'ios', 'tvos'] } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-exec-test-')));
  const qa = path.join(ws, 'acme-qa');
  const code = path.join(ws, 'acme-app');
  fs.mkdirSync(path.join(qa, '.git'), { recursive: true });
  fs.mkdirSync(path.join(code, '.git'), { recursive: true });
  for (const f of ['checkout/test-plan.md', 'payments/test-plan.md', ...smoke.map((s) => `smoke/${s}/smoke-suite.md`)]) {
    fs.mkdirSync(path.dirname(path.join(qa, f)), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, f), path.join(qa, f));
  }
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 2, 9, 0, 0) + tick++ * 1000).toISOString();
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
  return { ws, qa, code, cli, ok, refused, ledger };
}

const DEVICES = [
  { surface: 'android', device: 'Pixel 8', os_runtime: 'Android 15' },
  { surface: 'ios', device: 'iPhone 16', os_runtime: 'iOS 18.4' },
  { surface: 'tvos', device: 'Apple TV 4K', os_runtime: 'tvOS 18' },
];

// feature:checkout with its approved plan, three required surfaces, one device each,
// and builds 103 / 104 shipping all three.
function feature({ surfaces = ['android', 'ios', 'tvos'], builds = ['103', '104'] } = {}) {
  const w = workspace();
  w.ok('init');
  w.ok('scope', 'create', '--scope', 'feature:checkout', '--created-by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'plans', '--value', '"checkout/test-plan.md"', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'surfaces', '--value', JSON.stringify(surfaces), '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'devices', '--value', JSON.stringify(DEVICES.filter((d) => surfaces.includes(d.surface))), '--by', 'dana');
  for (const id of builds) w.ok('build', 'add', '--id', id, '--surfaces', 'android,ios,tvos', '--version', `2.4.0 (${id})`, '--registered-by', 'dana', '--related-scope', 'feature:checkout');
  return w;
}

const deviceFor = (surface) => DEVICES.find((d) => d.surface === surface).device;

function openSmoke(w, build, surface, scope = 'feature:checkout') {
  return w.ok('run', 'open', '--type', 'smoke', '--scope', scope, '--build', build, '--surface', surface, '--device', deviceFor(surface), '--executor', 'dana', '--plan', `smoke/${surface}/smoke-suite.md`).run_id;
}

// Runs the full smoke suite; `results` maps case index → result (default pass).
function smoke(w, build, surface, results = [], scope) {
  const run = openSmoke(w, build, surface, scope);
  const cases = w.ok('view', 'run-cases', '--run', run).cases;
  cases.forEach((c, i) => w.ok('result', 'add', '--run', run, '--case', c.case_key, '--result', results[i] ?? 'pass'));
  w.ok('run', 'close', '--run', run);
  return run;
}

function openFunctional(w, build, surface, extra = []) {
  return w.ok('run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', build, '--surface', surface, '--device', deviceFor(surface), '--executor', 'dana', '--plan', 'checkout/test-plan.md', ...extra).run_id;
}
function refuseFunctional(w, code, build, surface) {
  return w.refused(code, 'run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', build, '--surface', surface, '--device', deviceFor(surface), '--executor', 'dana', '--plan', 'checkout/test-plan.md');
}

const exec = (w, surface) => w.ok('view', 'execution', '--scope', 'feature:checkout', '--surface', surface).surfaces[0];
const caseIn = (surfaceView, key) => surfaceView.cases.find((c) => c.case_key === key);

// ---------- builds ----------

test('S2-01 register-build creates an immutable build tied to the feature', () => {
  const w = feature({ builds: [] });
  const b = w.ok('build', 'add', '--id', '103', '--surfaces', 'android,ios', '--version', '2.4.0 (103)', '--source', 'https://ci.example/builds/103', '--registered-by', 'dana', '--related-scope', 'feature:checkout').build;
  assert.equal(b.version, '2.4.0 (103)');
  assert.deepEqual(b.related_scopes, ['feature:checkout']);
  const bytes = fs.readFileSync(w.ledger('builds', '103.json'));
  w.refused('DUPLICATE_BUILD', 'build', 'add', '--id', '103', '--surfaces', 'android', '--registered-by', 'omer', '--related-scope', 'feature:checkout');
  smoke(w, '103', 'android');
  assert.deepEqual(fs.readFileSync(w.ledger('builds', '103.json')), bytes, 'executing against a build never touches its record');
});

test('S2-02 multiple builds for the same feature are preserved in order', () => {
  const w = feature({ builds: ['103', '104', '105'] });
  const builds = w.ok('view', 'builds', '--scope', 'feature:checkout').builds.map((b) => b.build_id);
  assert.deepEqual(builds, ['103', '104', '105']);
  assert.equal(exec(w, 'android').latest_build, '105');
});

// ---------- scope & device matrix ----------

test('S2-03 a feature scope can require several surfaces', () => {
  const w = feature();
  const view = w.ok('view', 'execution', '--scope', 'feature:checkout');
  assert.deepEqual(view.surfaces.map((s) => [s.surface, s.required]), [
    ['android', true],
    ['ios', true],
    ['tvos', true],
  ]);
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'surfaces', '--value', '["android","ios"]', '--by', 'dana');
  assert.deepEqual(w.ok('view', 'execution', '--scope', 'feature:checkout').surfaces.map((s) => s.surface), ['android', 'ios'], 'tvos is no longer required');
  refuseFunctional(w, 'SURFACE_NOT_IN_SCOPE', '103', 'tvos');
});

test('S2-04 devices and runtimes are recorded per surface and enforced for functional runs', () => {
  const w = feature();
  smoke(w, '103', 'android');
  w.refused('DEVICE_NOT_IN_SCOPE', 'run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Galaxy S24', '--executor', 'dana', '--plan', 'checkout/test-plan.md');
  w.refused('DEVICE_NOT_IN_SCOPE', 'run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--os-runtime', 'Android 14', '--executor', 'dana', '--plan', 'checkout/test-plan.md');
  const run = openFunctional(w, '103', 'android');
  const header = w.ok('view', 'runs', '--build', '103').runs.find((r) => r.run_id === run);
  assert.equal(header.os_runtime, 'Android 15', 'the declared runtime is carried onto the run');

  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'devices', '--value', JSON.stringify([...DEVICES, { surface: 'android', device: 'Pixel 8', os_runtime: 'Android 14' }]), '--by', 'dana');
  w.refused('AMBIGUOUS_DEVICE', 'run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'checkout/test-plan.md');
  openFunctional(w, '103', 'android', ['--os-runtime', 'Android 14']);
  const devices = exec(w, 'android').devices;
  assert.deepEqual(devices.map((d) => [d.device, d.os_runtime, d.declared]), [
    ['Pixel 8', 'Android 15', true],
    ['Pixel 8', 'Android 14', true],
  ]);
});

// ---------- smoke suite ----------

test('S2-05 a smoke suite is QA-authored, surface-specific, and never invented', () => {
  const w = feature();
  const check = w.ok('suite', 'check', '--suite', 'smoke/android/smoke-suite.md');
  assert.equal(check.surface, 'android');
  assert.deepEqual(check.rows.map((r) => [r.case_key, r.source]), [
    ['smoke/android/S1', 'QA-authored'],
    ['smoke/android/S2', 'checkout/TC1'],
  ]);
  assert.equal(check.rows[1].source_status, 'approved', 'a referenced plan case is resolved against its approved plan');

  // The android suite cannot smoke-test ios; a run needs exactly the suite for its surface.
  w.refused('INVALID_SMOKE_SUITE', 'run', 'open', '--type', 'smoke', '--scope', 'feature:checkout', '--build', '103', '--surface', 'ios', '--device', 'iPhone 16', '--executor', 'dana', '--plan', 'smoke/android/smoke-suite.md');
  w.refused('SMOKE_SUITE_REQUIRED', 'run', 'open', '--type', 'smoke', '--scope', 'feature:checkout', '--build', '103', '--surface', 'ios', '--device', 'iPhone 16', '--executor', 'dana');
  w.refused('INVALID_SMOKE_SUITE', 'run', 'open', '--type', 'smoke', '--scope', 'feature:checkout', '--build', '103', '--surface', 'ios', '--device', 'iPhone 16', '--executor', 'dana', '--plan', 'checkout/test-plan.md');

  // No suite for a surface → no smoke, and nothing is generated for it.
  const bare = workspace({ smoke: ['android'] });
  bare.ok('init');
  bare.ok('scope', 'create', '--scope', 'feature:checkout', '--created-by', 'dana');
  bare.ok('build', 'add', '--id', '1', '--surfaces', 'tvos', '--registered-by', 'dana');
  bare.refused('UNKNOWN_PLAN', 'run', 'open', '--type', 'smoke', '--scope', 'feature:checkout', '--build', '1', '--surface', 'tvos', '--device', 'Apple TV 4K', '--executor', 'dana', '--plan', 'smoke/tvos/smoke-suite.md');
  assert.equal(fs.existsSync(path.join(bare.qa, 'smoke', 'tvos')), false, 'no smoke suite was invented');

  // Malformed suites are rejected by suite check: wrong surface, duplicate ids, retired id reuse, dangling source.
  const suite = path.join(w.qa, 'smoke', 'ios', 'smoke-suite.md');
  const original = fs.readFileSync(suite, 'utf8');
  const bad = (text, code) => {
    fs.writeFileSync(suite, text);
    const r = w.cli('suite', 'check', '--suite', 'smoke/ios/smoke-suite.md');
    assert.notEqual(r.code, 0, r.out);
    assert.ok(r.json.errors.some((e) => e.code === code), `${code} in ${r.out}`);
  };
  bad(original.replace('surface: ios', 'surface: android'), 'SURFACE_MISMATCH');
  bad(original.replace('| S2 |', '| S1 |'), 'DUPLICATE_CASE_ID');
  bad(original.replace('- None', '- S2 — merged into S1'), 'RETIRED_ID_REUSED');
  bad(original.replace('checkout/TC1', 'checkout/TC999'), 'UNKNOWN_SOURCE');
  bad(original.replace('checkout/TC1', 'payments/TC1'), 'SOURCE_NOT_APPROVED');
  fs.writeFileSync(suite, original);
  w.ok('suite', 'check', '--suite', 'smoke/ios/smoke-suite.md');
});

// ---------- smoke gate ----------

test('S2-06 functional execution cannot start before smoke passes', () => {
  const w = feature();
  let r = refuseFunctional(w, 'SMOKE_GATE_CLOSED', '103', 'android');
  assert.equal(r.error.details.smoke_status, 'not_started');
  const run = openSmoke(w, '103', 'android');
  r = refuseFunctional(w, 'SMOKE_GATE_CLOSED', '103', 'android');
  assert.equal(r.error.details.smoke_status, 'in_progress');
  w.refused('SMOKE_IN_PROGRESS', 'run', 'open', '--type', 'smoke', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'omer', '--plan', 'smoke/android/smoke-suite.md');
  w.ok('result', 'add', '--run', run, '--case', 'smoke/android/S1', '--result', 'pass');
  w.refused('SMOKE_INCOMPLETE', 'run', 'close', '--run', run);
  w.ok('result', 'add', '--run', run, '--case', 'smoke/android/S2', '--result', 'pass');
  w.ok('run', 'close', '--run', run);
  openFunctional(w, '103', 'android');
});

test('S2-07 a smoke FAIL rejects the build for that surface and blocks functional execution', () => {
  const w = feature();
  smoke(w, '103', 'android', ['pass', 'fail']);
  const r = refuseFunctional(w, 'SMOKE_GATE_CLOSED', '103', 'android');
  assert.equal(r.error.details.smoke_status, 'failed');
  w.refused('SMOKE_ALREADY_RECORDED', 'run', 'open', '--type', 'smoke', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'smoke/android/smoke-suite.md');
  const status = w.ok('view', 'smoke', '--build', '103', '--surface', 'android').surfaces[0];
  assert.equal(status.status, 'failed');
  assert.equal(status.gate_open, false);
  // The normal way forward is a new build.
  smoke(w, '104', 'android');
  openFunctional(w, '104', 'android');
});

test('S2-08 a smoke BLOCKED blocks functional execution', () => {
  const w = feature();
  smoke(w, '103', 'android', ['blocked', 'pass']);
  assert.equal(refuseFunctional(w, 'SMOKE_GATE_CLOSED', '103', 'android').error.details.smoke_status, 'blocked');
  smoke(w, '103', 'ios', ['pass', 'not_run']);
  assert.equal(refuseFunctional(w, 'SMOKE_GATE_CLOSED', '103', 'ios').error.details.smoke_status, 'incomplete', 'NOT_RUN smoke cases are not a pass');
});

test('S2-09 an explicit smoke override opens the gate for one scope and records its reason', () => {
  const w = feature({ builds: ['103'] });
  smoke(w, '103', 'android', ['pass', 'fail']);
  w.refused('INVALID_VALUE', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'smoke_overrides', '--value', '{"build_id":"103","surface":"android"}', '--by', 'dana');
  w.refused('INVALID_VALUE', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'smoke_overrides', '--value', '{"build_id":"103","surface":"android","reason":"  "}', '--by', 'dana');
  w.refused('UNKNOWN_BUILD', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'smoke_overrides', '--value', '{"build_id":"999","surface":"android","reason":"x"}', '--by', 'dana');
  w.refused('SURFACE_NOT_IN_BUILD', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'smoke_overrides', '--value', '{"build_id":"103","surface":"web","reason":"x"}', '--by', 'dana');
  const reason = 'S2 fails only on the cart badge; checkout flow is unaffected — approved by QA lead';
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'smoke_overrides', '--value', JSON.stringify({ build_id: '103', surface: 'android', reason }), '--by', 'dana');
  openFunctional(w, '103', 'android');

  const status = w.ok('view', 'smoke', '--build', '103', '--surface', 'android').surfaces[0];
  assert.equal(status.status, 'failed', 'the override never rewrites the smoke result');
  assert.deepEqual(status.overrides, [{ scope: 'feature:checkout', reason, by: 'dana' }]);
  assert.deepEqual(exec(w, 'android').gate, { open: true, via: 'override', build_id: '103', reason });

  // Scope-specific: another feature on the same build is still gated.
  w.ok('scope', 'create', '--scope', 'feature:wallet', '--created-by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:wallet', '--op', 'add', '--field', 'plans', '--value', '"checkout/test-plan.md"', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:wallet', '--op', 'set', '--field', 'surfaces', '--value', '["android"]', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:wallet', '--op', 'set', '--field', 'devices', '--value', JSON.stringify([DEVICES[0]]), '--by', 'dana');
  w.refused('SMOKE_GATE_CLOSED', 'run', 'open', '--type', 'functional', '--scope', 'feature:wallet', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'checkout/test-plan.md');

  // Retracting the override closes the gate again; the history keeps both events.
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'retract', '--field', 'smoke_overrides', '--value', '"103@android"', '--by', 'dana', '--reason', 'Lead withdrew approval');
  refuseFunctional(w, 'SMOKE_GATE_CLOSED', '103', 'android');
  assert.equal(w.ok('validate').errors.length, 0, 'the functional run opened under the override stays valid');
});

test('S2-10 a smoke PASS opens functional execution; smoke is once per build and surface', () => {
  const w = feature();
  const aborted = openSmoke(w, '103', 'android');
  w.ok('run', 'abort', '--run', aborted, '--reason', 'Device disconnected');
  assert.equal(w.ok('view', 'smoke', '--build', '103', '--surface', 'android').surfaces[0].status, 'not_started', 'an aborted smoke is void');
  const run = smoke(w, '103', 'android');
  const status = w.ok('view', 'smoke', '--build', '103', '--surface', 'android').surfaces[0];
  assert.equal(status.status, 'passed');
  assert.equal(status.run_id, run);
  assert.deepEqual(status.history.map((h) => h.state), ['aborted', 'closed']);
  w.refused('SMOKE_ALREADY_RECORDED', 'run', 'open', '--type', 'smoke', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'smoke/android/smoke-suite.md');
  openFunctional(w, '103', 'android');
  refuseFunctional(w, 'SMOKE_GATE_CLOSED', '104', 'android');
});

// ---------- functional execution ----------

test('S2-11 PASS / FAIL / BLOCKED / NOT_RUN persist and show up per case', () => {
  const w = feature();
  smoke(w, '103', 'android');
  const run = openFunctional(w, '103', 'android');
  const results = { 'checkout/TC1': 'pass', 'checkout/TC14': 'fail', 'checkout/EC1': 'blocked', 'checkout/EC-U1': 'not_run' };
  for (const [key, result] of Object.entries(results)) w.ok('result', 'add', '--run', run, '--case', key, '--result', result, '--notes', `${result} note`, '--evidence', `evidence/${key.replace('/', '-')}.png`);
  w.ok('run', 'close', '--run', run);
  const view = exec(w, 'android');
  for (const [key, result] of Object.entries(results)) {
    const c = caseIn(view, key);
    assert.equal(c.status, result);
    assert.equal(c.latest.notes, `${result} note`);
    assert.deepEqual(c.latest.evidence, [`evidence/${key.replace('/', '-')}.png`]);
  }
  assert.deepEqual(view.summary, { pass: 1, fail: 1, blocked: 1, not_run: 1, stale: 0, pending: 2, excluded: 0, total: 6 });
  assert.deepEqual(view.pending, ['checkout/I18N1', 'checkout/A11Y1']);

  // A run still in progress is provisional: its results never replace closed evidence.
  const open = openFunctional(w, '103', 'android');
  w.ok('result', 'add', '--run', open, '--case', 'checkout/TC1', '--result', 'fail');
  w.ok('result', 'add', '--run', open, '--case', 'checkout/I18N1', '--result', 'pass');
  const during = exec(w, 'android');
  assert.equal(caseIn(during, 'checkout/TC1').status, 'pass');
  assert.equal(caseIn(during, 'checkout/I18N1').status, 'pending');
});

test('S2-12 a functional FAIL is only a result — no bug is created', () => {
  const w = feature();
  smoke(w, '103', 'android');
  const before = w.ok('validate').counts.scopes;
  const run = openFunctional(w, '103', 'android');
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'fail', '--notes', 'Spinner never ends');
  w.ok('run', 'close', '--run', run);
  assert.equal(w.ok('validate').counts.scopes, before);
  assert.equal(fs.existsSync(w.ledger('scopes', 'bug')), false);
  assert.deepEqual(caseIn(exec(w, 'android'), 'checkout/TC14').latest.bug_refs, []);
});

test('S2-13 execution history is append-only', () => {
  const w = feature();
  const files = () => Object.fromEntries(['builds', 'runs', 'scopes/feature'].flatMap((d) => (fs.existsSync(w.ledger(d)) ? fs.readdirSync(w.ledger(d)).map((f) => [`${d}/${f}`, fs.readFileSync(w.ledger(d, f), 'utf8')]) : [])));
  const steps = [
    () => smoke(w, '103', 'android', ['pass', 'fail']),
    () => smoke(w, '104', 'android'),
    () => w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'exclusions', '--value', '{"case_key":"checkout/EC-U1","surface":"tvos","reason":"No network toggle on tvOS"}', '--by', 'dana'),
    () => {
      const r = openFunctional(w, '104', 'android');
      w.ok('result', 'add', '--run', r, '--case', 'checkout/TC14', '--result', 'fail');
      w.ok('run', 'close', '--run', r);
    },
    () => {
      const r = openFunctional(w, '104', 'android');
      w.ok('result', 'add', '--run', r, '--case', 'checkout/TC14', '--result', 'pass');
      w.ok('run', 'close', '--run', r);
    },
  ];
  for (const step of steps) {
    const before = files();
    step();
    const after = files();
    for (const [f, text] of Object.entries(before)) assert.ok(after[f].startsWith(text), `${f} only grew`);
  }
  const history = w.ok('view', 'case-history', '--case', 'checkout/TC14', '--surface', 'android').history;
  assert.deepEqual(history.map((h) => h.result), ['fail', 'pass'], 'the later PASS sits next to the earlier FAIL');
});

// ---------- stale plan rows ----------

test('S2-14 a changed test-plan row makes earlier evidence stale without deleting it', () => {
  const w = feature();
  smoke(w, '103', 'android');
  const run = openFunctional(w, '103', 'android');
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'pass');
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'pass');
  w.ok('run', 'close', '--run', run);
  assert.equal(caseIn(exec(w, 'android'), 'checkout/TC14').status, 'pass');

  // What /sync-qa-test-plan does to a row: its wording changes, its id stays.
  const plan = path.join(w.qa, 'checkout', 'test-plan.md');
  fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace('The confirmation screen appears', 'The receipt screen appears'));
  const view = exec(w, 'android');
  const tc14 = caseIn(view, 'checkout/TC14');
  assert.equal(tc14.status, 'stale');
  assert.equal(tc14.latest.result, 'pass', 'the old result is still shown, flagged, never counted as current');
  assert.notEqual(tc14.latest.row_hash, tc14.current_row_hash);
  assert.equal(caseIn(view, 'checkout/TC1').status, 'pass', 'unchanged rows keep their evidence');
  assert.deepEqual(view.stale, ['checkout/TC14']);
  assert.equal(view.summary.stale, 1);

  const again = openFunctional(w, '103', 'android');
  w.ok('result', 'add', '--run', again, '--case', 'checkout/TC14', '--result', 'pass');
  w.ok('run', 'close', '--run', again);
  assert.equal(caseIn(exec(w, 'android'), 'checkout/TC14').status, 'pass');
  assert.equal(w.ok('view', 'case-history', '--case', 'checkout/TC14').history.length, 2);
});

test('S2-15 old execution history remains queryable', () => {
  const w = feature({ builds: ['103', '104', '105'] });
  smoke(w, '103', 'android', ['pass', 'fail']);
  smoke(w, '104', 'android');
  const r104 = openFunctional(w, '104', 'android');
  w.ok('result', 'add', '--run', r104, '--case', 'checkout/TC14', '--result', 'fail');
  w.ok('run', 'close', '--run', r104);
  smoke(w, '105', 'android');
  const r105 = openFunctional(w, '105', 'android');
  w.ok('result', 'add', '--run', r105, '--case', 'checkout/TC14', '--result', 'pass');
  w.ok('run', 'close', '--run', r105);

  assert.equal(w.ok('view', 'smoke', '--build', '103').surfaces.find((s) => s.surface === 'android').status, 'failed', 'build 103 stays rejected');
  const history = w.ok('view', 'case-history', '--case', 'checkout/TC14', '--scope', 'feature:checkout').history;
  assert.deepEqual(history.map((h) => [h.build_id, h.result]), [
    ['104', 'fail'],
    ['105', 'pass'],
  ]);
  const smokeHistory = w.ok('view', 'case-history', '--case', 'smoke/android/S2').history;
  assert.deepEqual(smokeHistory.map((h) => [h.build_id, h.result]), [
    ['103', 'fail'],
    ['104', 'pass'],
    ['105', 'pass'],
  ]);
  const tc14 = caseIn(exec(w, 'android'), 'checkout/TC14');
  assert.equal(tc14.latest.build_id, '105');
  assert.equal(tc14.on_latest_build, true);
});

// ---------- multi-surface ----------

test('S2-16 each surface is gated and tracked independently', () => {
  const w = feature({ builds: ['103'] });
  smoke(w, '103', 'android');
  smoke(w, '103', 'ios', ['fail', 'pass']);
  const a = openFunctional(w, '103', 'android');
  refuseFunctional(w, 'SMOKE_GATE_CLOSED', '103', 'ios');
  refuseFunctional(w, 'SMOKE_GATE_CLOSED', '103', 'tvos');
  w.ok('result', 'add', '--run', a, '--case', 'checkout/TC1', '--result', 'pass');
  w.ok('run', 'close', '--run', a);
  const view = w.ok('view', 'execution', '--scope', 'feature:checkout');
  const by = Object.fromEntries(view.surfaces.map((s) => [s.surface, s]));
  assert.equal(by.android.smoke.status, 'passed');
  assert.equal(by.ios.smoke.status, 'failed');
  assert.equal(by.tvos.smoke.status, 'not_started');
  assert.equal(caseIn(by.android, 'checkout/TC1').status, 'pass');
  assert.equal(caseIn(by.ios, 'checkout/TC1').status, 'pending', 'an android PASS is not iOS evidence');
  assert.deepEqual(w.ok('view', 'smoke', '--build', '103').surfaces.map((s) => [s.surface, s.status]), [
    ['android', 'passed'],
    ['ios', 'failed'],
    ['tvos', 'not_started'],
  ]);
});

// ---------- preservation ----------

test('S2-17 the existing planning commands are untouched and plans are never rewritten', () => {
  for (const name of PLANNING_COMMANDS) {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, 'commands', `${name}.md`), 'utf8');
    assert.ok(!text.includes('qa-ledger'), `${name} does not call the ledger`);
    for (const c of STAGE2_COMMANDS) assert.ok(!text.includes(`/${c}`), `${name} does not depend on /${c}`);
  }
  const w = feature();
  const planBytes = fs.readFileSync(path.join(w.qa, 'checkout', 'test-plan.md'));
  const suiteBytes = fs.readFileSync(path.join(w.qa, 'smoke', 'android', 'smoke-suite.md'));
  smoke(w, '103', 'android');
  const run = openFunctional(w, '103', 'android');
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'pass');
  w.ok('run', 'close', '--run', run);
  w.ok('view', 'execution', '--scope', 'feature:checkout');
  w.ok('suite', 'check', '--suite', 'smoke/android/smoke-suite.md');
  assert.deepEqual(fs.readFileSync(path.join(w.qa, 'checkout', 'test-plan.md')), planBytes);
  assert.deepEqual(fs.readFileSync(path.join(w.qa, 'smoke', 'android', 'smoke-suite.md')), suiteBytes);
});

test('S2-18 manual execution works end to end with no automation present', () => {
  const w = feature({ surfaces: ['tvos'] });
  assert.equal(fs.existsSync(path.join(w.qa, 'automation')), false);
  smoke(w, '103', 'tvos');
  const run = w.ok('run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'tvos', '--device', 'Apple TV 4K', '--executor', 'dana (manual)', '--plan', 'checkout/test-plan.md').run_id;
  for (const c of w.ok('view', 'run-cases', '--run', run).cases) w.ok('result', 'add', '--run', run, '--case', c.case_key, '--result', 'pass');
  w.ok('run', 'close', '--run', run);
  assert.equal(exec(w, 'tvos').summary.pass, 6);
  assert.equal(fs.existsSync(path.join(w.qa, 'automation')), false, 'nothing automation-related was created');
});

function sources() {
  const files = [path.join(HERE, 'qa-ledger.mjs')];
  const lib = path.join(HERE, 'lib', 'qa-ledger');
  // Since Stage 5, lib/qa-ledger/knowledge.mjs is the one designated Project Knowledge consumer; no other module may touch it.
  if (fs.existsSync(lib)) for (const f of fs.readdirSync(lib)) if (f !== 'knowledge.mjs') files.push(path.join(lib, f));
  return files.map((f) => [path.relative(PLUGIN_ROOT, f), fs.readFileSync(f, 'utf8')]);
}

test('S2-19 no Project Knowledge is consumed', () => {
  const w = feature();
  fs.mkdirSync(path.join(w.code, '.ono'));
  fs.writeFileSync(path.join(w.code, '.ono', 'repo-knowledge.json'), '{"surfaces":[{"id":"web"}],"capabilities":[]}');
  smoke(w, '103', 'android');
  assert.deepEqual(w.ok('view', 'execution', '--scope', 'feature:checkout').surfaces.map((s) => s.surface), ['android', 'ios', 'tvos'], 'surfaces come only from QA-entered scope context');
  for (const [file, text] of sources()) {
    for (const needle of ['repo-knowledge', 'docs/project', 'capabilityRelationships']) assert.ok(!text.includes(needle), `${file} must not read ${needle}`);
  }
  for (const c of STAGE2_COMMANDS) {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, 'commands', `${c}.md`), 'utf8');
    assert.ok(!/repo-knowledge|docs\/project|Project Knowledge capabilit/.test(text), `/${c} must not consume Project Knowledge`);
  }
});

test('S2-20 no readiness or sign-off logic exists yet', () => {
  const w = feature();
  for (const cmd of [['readiness'], ['signoff'], ['view', 'readiness'], ['qa-readiness']]) w.refused('UNKNOWN_COMMAND', ...cmd, '--scope', 'feature:checkout');
  for (const name of fs.readdirSync(path.join(PLUGIN_ROOT, 'commands'))) assert.ok(!/readiness|sign-?off/i.test(name), `no ${name} yet`);
  smoke(w, '103', 'android');
  const view = JSON.stringify(w.ok('view', 'execution', '--scope', 'feature:checkout'));
  assert.ok(!/READY|verdict|sign_?off/i.test(view), 'operational views carry no readiness verdict');
});

// ---------- rules around plans, exclusions and walking cases ----------

test('S2-21 functional runs need a feature scope, an approved plan attached to it, and a required surface', () => {
  const w = feature();
  smoke(w, '103', 'android');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'plans', '--value', '"payments/test-plan.md"', '--by', 'dana');
  w.refused('PLAN_NOT_APPROVED', 'run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'payments/test-plan.md');
  w.refused('PLAN_REQUIRED', 'run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana');
  w.ok('scope', 'create', '--scope', 'feature:other', '--created-by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:other', '--op', 'set', '--field', 'surfaces', '--value', '["android"]', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:other', '--op', 'set', '--field', 'devices', '--value', JSON.stringify([DEVICES[0]]), '--by', 'dana');
  w.refused('PLAN_NOT_IN_SCOPE', 'run', 'open', '--type', 'functional', '--scope', 'feature:other', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'checkout/test-plan.md');
  w.ok('scope', 'create', '--scope', 'bug:BUG-1', '--created-by', 'dana');
  w.refused('FUNCTIONAL_REQUIRES_FEATURE', 'run', 'open', '--type', 'functional', '--scope', 'bug:BUG-1', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'checkout/test-plan.md');
  w.refused('INVALID_VALUE', 'run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'smoke/android/smoke-suite.md');
});

test('S2-22 per-surface exclusions remove a case from that surface only', () => {
  const w = feature();
  w.refused('UNKNOWN_CASE', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'exclusions', '--value', '{"case_key":"checkout/TC999","surface":"tvos","reason":"x"}', '--by', 'dana');
  w.refused('SURFACE_NOT_IN_SCOPE', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'exclusions', '--value', '{"case_key":"checkout/EC-U1","surface":"web","reason":"x"}', '--by', 'dana');
  w.refused('INVALID_VALUE', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'exclusions', '--value', '{"case_key":"checkout/EC-U1","surface":"tvos"}', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'exclusions', '--value', '{"case_key":"checkout/EC-U1","surface":"tvos","reason":"tvOS has no user-facing network toggle"}', '--by', 'dana');
  smoke(w, '103', 'tvos');
  const run = openFunctional(w, '103', 'tvos');
  assert.ok(!w.ok('view', 'run-cases', '--run', run).cases.some((c) => c.case_key === 'checkout/EC-U1'));
  w.refused('CASE_EXCLUDED', 'result', 'add', '--run', run, '--case', 'checkout/EC-U1', '--result', 'pass');
  const tv = exec(w, 'tvos');
  assert.equal(caseIn(tv, 'checkout/EC-U1').status, 'excluded');
  assert.equal(caseIn(tv, 'checkout/EC-U1').exclusion_reason, 'tvOS has no user-facing network toggle');
  assert.equal(tv.summary.excluded, 1);
  assert.equal(caseIn(exec(w, 'android'), 'checkout/EC-U1').status, 'pending', 'android still requires it');
});

test('S2-23 run-cases walks a run deterministically and tracks what is left', () => {
  const w = feature();
  const s = openSmoke(w, '103', 'android');
  assert.deepEqual(w.ok('view', 'run-cases', '--run', s).cases.map((c) => c.case_key), ['smoke/android/S1', 'smoke/android/S2']);
  w.ok('result', 'add', '--run', s, '--case', 'smoke/android/S1', '--result', 'pass');
  const walk = w.ok('view', 'run-cases', '--run', s);
  assert.deepEqual(walk.remaining, ['smoke/android/S2']);
  assert.equal(walk.cases[0].result, 'pass');
  assert.equal(walk.cases[1].result, null);
  w.ok('result', 'add', '--run', s, '--case', 'smoke/android/S2', '--result', 'pass');
  w.ok('run', 'close', '--run', s);
  const f = openFunctional(w, '103', 'android');
  const cases = w.ok('view', 'run-cases', '--run', f).cases;
  assert.deepEqual(cases.map((c) => c.case_key), ['checkout/TC1', 'checkout/TC14', 'checkout/EC1', 'checkout/EC-U1', 'checkout/I18N1', 'checkout/A11Y1']);
  assert.equal(cases[0].section, 'Functional Test Cases');
  assert.deepEqual(w.ok('view', 'run-cases', '--run', f), w.ok('view', 'run-cases', '--run', f));
});

// ---------- post-hoc validation of the gate ----------

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const seal = ({ hash, ...rest }) => ({ ...rest, hash: `sha256:${sha256(canonical(rest))}` });

test('S2-24 validate catches a functional run that bypassed the smoke gate or a second smoke', () => {
  const w = feature();
  smoke(w, '103', 'android');
  const run = openFunctional(w, '103', 'android');
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'pass');
  w.ok('run', 'close', '--run', run);
  assert.equal(w.ok('validate').errors.length, 0);

  // A sealed, well-chained functional run on build 104 that never had smoke.
  const recs = fs.readFileSync(w.ledger('runs', `${run}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const forgedId = run.replace(/-[0-9a-f]{8}$/, '-0badf00d');
  const header = seal({ ...recs[0], run_id: forgedId, build_id: '104' });
  const result = seal({ ...recs[1], prev: header.hash, result_id: `${forgedId}/1` });
  const close = seal({ ...recs[2], prev: result.hash });
  fs.writeFileSync(w.ledger('runs', `${forgedId}.jsonl`), [header, result, close].map(canonical).join('\n') + '\n');
  let codes = w.cli('validate').json.errors.map((e) => e.code);
  assert.ok(codes.includes('GATE_NOT_HELD'), codes);
  fs.rmSync(w.ledger('runs', `${forgedId}.jsonl`));

  // A second closed smoke run for the same build and surface.
  const smokeRun = w.ok('view', 'smoke', '--build', '103', '--surface', 'android').surfaces[0].run_id;
  const srecs = fs.readFileSync(w.ledger('runs', `${smokeRun}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const secondId = smokeRun.replace(/-[0-9a-f]{8}$/, '-0badf00d');
  const out = [];
  for (const r of srecs) {
    const copy = { ...r, prev: out.length ? out[out.length - 1].hash : null };
    if (copy.kind === 'run.opened') copy.run_id = secondId;
    if (copy.result_id) copy.result_id = copy.result_id.replace(smokeRun, secondId);
    out.push(seal(copy));
  }
  fs.writeFileSync(w.ledger('runs', `${secondId}.jsonl`), out.map(canonical).join('\n') + '\n');
  codes = w.cli('validate').json.errors.map((e) => e.code);
  assert.ok(codes.includes('DUPLICATE_SMOKE'), codes);
});

test('S2-25 the ledger keeps one writer: only the store module touches the filesystem for writes', () => {
  const writers = /\b(writeFileSync|appendFileSync|mkdirSync|renameSync|rmSync|unlinkSync|copyFileSync|createWriteStream)\b/;
  for (const [file, text] of sources()) {
    if (file.endsWith(path.join('lib', 'qa-ledger', 'store.mjs'))) continue;
    assert.ok(!writers.test(text), `${file} must not write to disk directly — go through Store`);
  }
  for (const [file, text] of sources()) {
    if (file.endsWith('qa-ledger.mjs') && !file.includes(path.join('lib', ''))) continue;
    assert.ok(!/new Store\(/.test(text), `${file} must not construct a Store — only the CLI entry point does`);
  }
});
