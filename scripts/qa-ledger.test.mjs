// Tests for scripts/qa-ledger.mjs — the QA ledger foundation (Stage 1).
//
// Every test builds a throwaway workspace (a QA repo next to a sibling code repo)
// under the OS temp dir, drives the helper through its CLI exactly as a command
// would, and inspects the files it wrote. Nothing real is touched.
//
// Run: node --test scripts/qa-ledger.test.mjs
// QA_LEDGER_HELPER overrides the helper path (used by qa-ledger.mutation.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(HERE);
const HELPER = process.env.QA_LEDGER_HELPER || path.join(HERE, 'qa-ledger.mjs');
const FIXTURE_PLAN = path.join(HERE, 'fixtures', 'qa-ledger', 'checkout', 'test-plan.md');

// ---------- harness ----------

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function workspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ledger-test-')));
  const qa = path.join(ws, 'acme-qa');
  const code = path.join(ws, 'acme-app');
  fs.mkdirSync(path.join(qa, '.git'), { recursive: true });
  fs.mkdirSync(path.join(code, '.git'), { recursive: true });
  fs.writeFileSync(path.join(code, 'App.tsx'), 'export default null;\n');
  fs.mkdirSync(path.join(qa, 'checkout'));
  fs.copyFileSync(FIXTURE_PLAN, path.join(qa, 'checkout', 'test-plan.md'));
  let tick = 0;
  // Deterministic, strictly increasing clock for every helper call.
  const now = () => new Date(Date.UTC(2026, 8, 1, 9, 0, 0) + tick++ * 1000).toISOString();
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [HELPER, ...args, '--qa-repo', qa], {
      encoding: 'utf8',
      env: { ...process.env, QA_LEDGER_NOW: now() },
    });
    let json = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      /* leave null — asserted by callers */
    }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const ok = (...args) => {
    const r = cli(...args);
    assert.equal(r.code, 0, `expected success for ${args.join(' ')}\n${r.stdout}${r.stderr}`);
    assert.equal(r.json.ok, true);
    return r.json;
  };
  const refused = (code, ...args) => {
    const r = cli(...args);
    assert.notEqual(r.code, 0, `expected refusal for ${args.join(' ')}\n${r.stdout}`);
    assert.ok(r.json, `refusal must still print JSON: ${r.stdout}${r.stderr}`);
    assert.equal(r.json.ok, false);
    if (code) assert.equal(r.json.error.code, code, JSON.stringify(r.json));
    return r.json;
  };
  const ledger = (...p) => path.join(qa, 'qa-ledger', ...p);
  return { ws, qa, code, cli, ok, refused, ledger };
}

// A snapshot of every file under a directory: relative path -> sha256.
function snapshot(dir, skip = () => false) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (skip(rel)) continue;
      if (e.isDirectory()) walk(p);
      else out[rel] = e.isSymbolicLink() ? `link:${fs.readlinkSync(p)}` : sha256(fs.readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

// Canonical JSON and the per-record hash, reimplemented from docs/qa-ledger-contract.md
// so the tests also check that the contract is implementable without the helper.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
function sealed(record) {
  const { hash, ...rest } = record;
  return { ...rest, hash: `sha256:${sha256(canonical(rest))}` };
}
function readStream(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
function writeStream(file, records) {
  fs.writeFileSync(file, records.map((r) => canonical(r)).join('\n') + '\n');
}

// A ready-made ledger: feature:checkout with its plan, and builds 103–105 on android.
function seeded() {
  const w = workspace();
  w.ok('init');
  w.ok('scope', 'create', '--scope', 'feature:checkout', '--created-by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'plans', '--value', '"checkout/test-plan.md"', '--by', 'dana');
  for (const id of ['103', '104', '105']) {
    w.ok('build', 'add', '--id', id, '--surfaces', 'android,ios', '--version', `2.4.0-${id}`, '--registered-by', 'dana', '--related-scope', 'feature:checkout');
  }
  return w;
}

function openRun(w, type, build, extra = []) {
  return w.ok('run', 'open', '--type', type, '--scope', 'feature:checkout', '--build', build, '--surface', 'android', '--device', 'Pixel 8', '--os-runtime', 'Android 15', '--executor', 'dana', '--plan', 'checkout/test-plan.md', ...extra).run_id;
}

// ---------- 1. feature scope without any bug ----------

test('01 a feature scope exists, is executed, and is valid with zero bugs', () => {
  const w = seeded();
  const run = openRun(w, 'functional', '103');
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'pass');
  w.ok('run', 'close', '--run', run);
  const view = w.ok('view', 'scope', '--scope', 'feature:checkout');
  assert.equal(view.scope.kind, 'feature');
  assert.deepEqual(view.scope.context.plans, ['checkout/test-plan.md']);
  assert.equal(fs.existsSync(w.ledger('scopes', 'bug')), false, 'no bug scope was created');
  assert.equal(w.ok('validate').errors.length, 0);
});

// ---------- 2. standalone bug scope ----------

test('02 a standalone bug scope needs no feature and no test plan', () => {
  const w = workspace();
  fs.rmSync(path.join(w.qa, 'checkout'), { recursive: true });
  w.ok('init');
  w.ok('scope', 'create', '--scope', 'bug:BUG-27', '--created-by', 'dana', '--title', 'Player freezes after resume');
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'set', '--field', 'surfaces', '--value', '["android-tv"]', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'add', '--field', 'cases', '--value', '{"id":"R1","summary":"Resume playback after 30s in background"}', '--by', 'dana');
  w.ok('build', 'add', '--id', 'atv-88', '--surfaces', 'android-tv', '--registered-by', 'dana');
  const run = w.ok('run', 'open', '--type', 'reproduction', '--scope', 'bug:BUG-27', '--build', 'atv-88', '--surface', 'android-tv', '--device', 'Chromecast with Google TV', '--executor', 'dana').run_id;
  w.ok('result', 'add', '--run', run, '--case', 'bug:BUG-27#R1', '--result', 'fail', '--notes', 'Reproduced 3/3');
  w.ok('run', 'close', '--run', run);
  const view = w.ok('view', 'scope', '--scope', 'bug:BUG-27');
  assert.equal(view.scope.kind, 'bug');
  assert.deepEqual(view.scope.context.surfaces, ['android-tv']);
  assert.equal(view.scope.context.plans, undefined, 'no plan is attached');
  assert.equal(fs.existsSync(w.ledger('scopes', 'feature')), false, 'no feature scope was needed');
  const onDisk = fs.readdirSync(w.qa).filter((n) => n !== '.git');
  assert.deepEqual(onDisk, ['qa-ledger'], 'no plan folder or fake feature was created');
  assert.equal(w.ok('validate').errors.length, 0);
});

// ---------- 3/4. builds ----------

test('03 multiple builds register without mutating earlier ones', () => {
  const w = workspace();
  w.ok('init');
  w.ok('build', 'add', '--id', '103', '--surfaces', 'android', '--registered-by', 'dana');
  const first = fs.readFileSync(w.ledger('builds', '103.json'));
  w.ok('build', 'add', '--id', '104', '--surfaces', 'android', '--version', '2.4.0 (104)', '--source', 'https://ci.example/104', '--registered-by', 'dana');
  w.ok('build', 'add', '--id', '105', '--surfaces', 'android', '--registered-by', 'omer');
  assert.deepEqual(fs.readFileSync(w.ledger('builds', '103.json')), first, 'build 103 is byte-identical');
  const builds = w.ok('view', 'builds', '--surface', 'android').builds;
  assert.deepEqual(builds.map((b) => b.build_id), ['103', '104', '105']);
  assert.equal(builds[0].version, null, 'version is optional — QA does not own it');
  assert.equal(builds[1].version, '2.4.0 (104)');
  assert.equal(w.ok('view', 'latest-build', '--surface', 'android').build.build_id, '105');
});

test('04 duplicate build ids are refused, case-insensitively, without touching the original', () => {
  const w = workspace();
  w.ok('init');
  w.ok('build', 'add', '--id', 'rc-1', '--surfaces', 'ios', '--registered-by', 'dana');
  const before = snapshot(w.ledger());
  w.refused('DUPLICATE_BUILD', 'build', 'add', '--id', 'rc-1', '--surfaces', 'android', '--registered-by', 'omer');
  w.refused('DUPLICATE_BUILD', 'build', 'add', '--id', 'RC-1', '--surfaces', 'android', '--registered-by', 'omer');
  assert.deepEqual(snapshot(w.ledger()), before);
});

// ---------- 5/6. runs ----------

test('05 a run must reference an existing scope, build, build surface and bug', () => {
  const w = seeded();
  const base = ['run', 'open', '--device', 'Pixel 8', '--executor', 'dana'];
  w.refused('UNKNOWN_SCOPE', ...base, '--type', 'functional', '--scope', 'feature:nope', '--build', '103', '--surface', 'android');
  w.refused('UNKNOWN_BUILD', ...base, '--type', 'functional', '--scope', 'feature:checkout', '--build', '999', '--surface', 'android');
  w.refused('SURFACE_NOT_IN_BUILD', ...base, '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'tvos');
  w.refused('BUG_REF_REQUIRED', ...base, '--type', 'retest', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android');
  w.refused('UNKNOWN_SCOPE', ...base, '--type', 'retest', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android', '--bug-ref', 'bug:BUG-404');
  w.refused('INVALID_BUG_REF', ...base, '--type', 'retest', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android', '--bug-ref', 'feature:checkout');
  w.refused('MISSING_ARGUMENT', 'run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--executor', 'dana');
  assert.equal(fs.existsSync(w.ledger('runs')) ? fs.readdirSync(w.ledger('runs')).length : 0, 0, 'no run file was written');
});

test('06 every future execution type opens structurally', () => {
  const w = seeded();
  w.ok('scope', 'create', '--scope', 'bug:BUG-27', '--created-by', 'dana');
  const types = {
    smoke: [],
    functional: [],
    regression: [],
    retest: ['--bug-ref', 'bug:BUG-27'],
    reproduction: ['--bug-ref', 'bug:BUG-27'],
  };
  for (const [type, extra] of Object.entries(types)) {
    const run = openRun(w, type, '104', extra);
    const view = w.ok('view', 'runs', '--build', '104').runs.find((r) => r.run_id === run);
    assert.equal(view.type, type);
    assert.equal(view.state, 'open');
  }
  w.refused('INVALID_VALUE', 'run', 'open', '--type', 'exploratory', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana');
});

test('07 pass / fail / blocked / not_run are the only accepted results', () => {
  const w = seeded();
  const run = openRun(w, 'functional', '103');
  const cases = { 'checkout/TC1': 'pass', 'checkout/TC14': 'fail', 'checkout/EC1': 'blocked', 'checkout/EC-U1': 'not_run' };
  for (const [key, result] of Object.entries(cases)) w.ok('result', 'add', '--run', run, '--case', key, '--result', result);
  for (const bad of ['PASS', 'passed', 'skip', '']) {
    w.refused(null, 'result', 'add', '--run', run, '--case', 'checkout/I18N1', '--result', bad);
  }
  w.ok('run', 'close', '--run', run);
  const history = w.ok('view', 'case-history', '--case', 'checkout/EC-U1').history;
  assert.equal(history[0].result, 'not_run');
});

// ---------- 8/9. append-only ----------

test('08 every write only appends to its stream', () => {
  const w = seeded();
  const scopeFile = w.ledger('scopes', 'feature', 'checkout.jsonl');
  const run = openRun(w, 'functional', '103');
  const runFile = w.ledger('runs', `${run}.jsonl`);
  const steps = [
    () => w.ok('result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'pass'),
    () => w.ok('result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'fail'),
    () => w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'surfaces', '--value', '["android"]', '--by', 'dana'),
    () => w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'surfaces', '--value', '["android","ios"]', '--by', 'dana'),
    () => w.ok('run', 'close', '--run', run),
  ];
  for (const step of steps) {
    const before = { scope: fs.readFileSync(scopeFile, 'utf8'), run: fs.readFileSync(runFile, 'utf8') };
    step();
    const after = { scope: fs.readFileSync(scopeFile, 'utf8'), run: fs.readFileSync(runFile, 'utf8') };
    assert.ok(after.scope.startsWith(before.scope), 'scope stream only grew');
    assert.ok(after.run.startsWith(before.run), 'run stream only grew');
  }
  const context = w.ok('view', 'scope', '--scope', 'feature:checkout').scope;
  assert.deepEqual(context.context.surfaces, ['android', 'ios'], 'the latest set wins in the derived view');
  assert.equal(readStream(scopeFile).filter((e) => e.field === 'surfaces').length, 2, 'both set events are kept');
});

test('09 a later PASS on build 104 never overwrites the FAIL on build 103', () => {
  const w = seeded();
  const r103 = openRun(w, 'functional', '103');
  w.ok('result', 'add', '--run', r103, '--case', 'checkout/TC14', '--result', 'fail', '--notes', 'Spinner never ends');
  w.ok('run', 'close', '--run', r103);
  const failLine = fs.readFileSync(w.ledger('runs', `${r103}.jsonl`), 'utf8');

  w.ok('scope', 'create', '--scope', 'bug:BUG-27', '--created-by', 'dana');
  const r104 = openRun(w, 'retest', '104', ['--bug-ref', 'bug:BUG-27']);
  w.ok('result', 'add', '--run', r104, '--case', 'checkout/TC14', '--result', 'pass', '--bug', 'bug:BUG-27');
  w.ok('run', 'close', '--run', r104);

  assert.equal(fs.readFileSync(w.ledger('runs', `${r103}.jsonl`), 'utf8'), failLine, 'the build-103 run is untouched');
  const history = w.ok('view', 'case-history', '--case', 'checkout/TC14', '--surface', 'android').history;
  assert.deepEqual(history.map((h) => [h.build_id, h.type, h.result]), [
    ['103', 'functional', 'fail'],
    ['104', 'retest', 'pass'],
  ]);
  const latest = w.ok('view', 'latest-result', '--case', 'checkout/TC14', '--surface', 'android').latest;
  assert.equal(latest.result, 'pass');
  assert.equal(latest.build_id, '104');
});

// ---------- 10. terminal runs ----------

test('10 closed and aborted runs cannot be mutated', () => {
  const w = seeded();
  const closed = openRun(w, 'functional', '103');
  const r1 = w.ok('result', 'add', '--run', closed, '--case', 'checkout/TC1', '--result', 'pass').result_id;
  w.ok('run', 'close', '--run', closed);
  const aborted = openRun(w, 'smoke', '104');
  w.ok('run', 'abort', '--run', aborted, '--reason', 'Device lost power');
  const before = snapshot(w.ledger('runs'));
  for (const run of [closed, aborted]) {
    w.refused('RUN_NOT_OPEN', 'result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'pass');
    w.refused('RUN_NOT_OPEN', 'run', 'close', '--run', run);
    w.refused('RUN_NOT_OPEN', 'run', 'abort', '--run', run, '--reason', 'again');
  }
  w.refused('RUN_NOT_OPEN', 'result', 'add', '--run', closed, '--case', 'checkout/TC1', '--result', 'fail', '--supersedes', r1);
  assert.deepEqual(snapshot(w.ledger('runs')), before);
  const runs = w.ok('view', 'runs').runs;
  assert.equal(runs.find((r) => r.run_id === closed).state, 'closed');
  assert.equal(runs.find((r) => r.run_id === aborted).state, 'aborted');
  w.refused('EMPTY_RUN', 'run', 'close', '--run', openRun(w, 'functional', '105'));
});

// ---------- 11. references ----------

test('11 invalid references are refused', () => {
  const w = seeded();
  const run = openRun(w, 'functional', '103');
  w.refused('UNKNOWN_SCOPE', 'result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'fail', '--bug', 'bug:BUG-404');
  w.refused('UNKNOWN_CASE', 'result', 'add', '--run', run, '--case', 'checkout/TC999', '--result', 'pass');
  w.refused('UNKNOWN_CASE', 'result', 'add', '--run', run, '--case', 'payments/TC1', '--result', 'pass');
  w.refused('UNKNOWN_CASE', 'result', 'add', '--run', run, '--case', 'bug:BUG-9#R1', '--result', 'pass');
  w.refused('UNKNOWN_RESULT', 'result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'pass', '--supersedes', `${run}/9`);
  w.refused('UNKNOWN_RUN', 'result', 'add', '--run', 'functional-20260101T000000Z-deadbeef', '--case', 'checkout/TC1', '--result', 'pass');
  w.refused('UNKNOWN_SCOPE', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'related_scopes', '--value', '"bug:BUG-404"', '--by', 'dana');
  w.refused('UNKNOWN_RESULT', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'result_refs', '--value', `"${run}/7"`, '--by', 'dana');
  w.refused('UNKNOWN_PLAN', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'plans', '--value', '"payments/test-plan.md"', '--by', 'dana');
  w.refused('UNKNOWN_PLAN', 'run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'payments/test-plan.md');
  w.refused('UNKNOWN_SCOPE', 'build', 'add', '--id', '106', '--surfaces', 'android', '--registered-by', 'dana', '--related-scope', 'feature:nope');
  w.refused('UNKNOWN_FIELD', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'verdict', '--value', '"READY"', '--by', 'dana');
  w.refused('INVALID_OP', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'surfaces', '--value', '"android"', '--by', 'dana');
  w.refused('INVALID_FIELD_FOR_SCOPE', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'members', '--value', '"feature:checkout"', '--by', 'dana');
  w.refused('DUPLICATE_SCOPE', 'scope', 'create', '--scope', 'feature:Checkout', '--created-by', 'dana');
  assert.equal(w.ok('validate').errors.length, 0, 'refusals left the ledger valid');
});

// ---------- 12. supersession ----------

test('12 corrections supersede within an open run only, and keep the original', () => {
  const w = seeded();
  const run = openRun(w, 'functional', '103');
  const other = openRun(w, 'functional', '104');
  const first = w.ok('result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'pass').result_id;
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'pass');
  const otherResult = w.ok('result', 'add', '--run', other, '--case', 'checkout/TC14', '--result', 'pass').result_id;

  w.refused('DUPLICATE_CASE_IN_RUN', 'result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'fail');
  w.refused('SUPERSEDE_CASE_MISMATCH', 'result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'fail', '--supersedes', first);
  w.refused('UNKNOWN_RESULT', 'result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'fail', '--supersedes', otherResult);

  const second = w.ok('result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'fail', '--supersedes', first, '--notes', 'Mis-clicked PASS').result_id;
  w.refused('ALREADY_SUPERSEDED', 'result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'blocked', '--supersedes', first);
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'blocked', '--supersedes', second);
  w.ok('run', 'close', '--run', run);

  const history = w.ok('view', 'case-history', '--case', 'checkout/TC14', '--scope', 'feature:checkout').history.filter((h) => h.run_id === run);
  assert.deepEqual(history.map((h) => [h.result, h.superseded_by !== null]), [
    ['pass', true],
    ['fail', true],
    ['blocked', false],
  ]);
  const view = w.ok('view', 'runs', '--build', '103').runs.find((r) => r.run_id === run);
  assert.equal(view.result_count, 4, 'all four result records are kept');
  assert.equal(view.effective_count, 2, 'TC1 plus the final TC14 correction');
  // The open run on build 104 is provisional, so latest-result for 103 comes from the closed run.
  assert.equal(w.ok('view', 'latest-result', '--case', 'checkout/TC14', '--surface', 'android').latest.result, 'blocked');
});

// ---------- 13. plans ----------

test('13 existing test plans stay byte-identical and are referenced deterministically', () => {
  const w = seeded();
  const planPath = path.join(w.qa, 'checkout', 'test-plan.md');
  const original = fs.readFileSync(planPath);
  const rows = w.ok('plan', 'rows', '--plan', 'checkout/test-plan.md');
  assert.deepEqual(rows.rows.map((r) => r.id), ['TC1', 'TC14', 'EC1', 'EC-U1', 'I18N1', 'A11Y1']);
  assert.equal(rows.rows[1].case_key, 'checkout/TC14');
  assert.equal(rows.fingerprint, `sha256:${sha256(original)}`);
  assert.deepEqual(w.ok('plan', 'rows', '--plan', 'checkout/test-plan.md'), rows, 'row parsing is deterministic');

  const run = openRun(w, 'functional', '103');
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'pass');
  w.ok('run', 'close', '--run', run);
  w.ok('validate');
  assert.deepEqual(fs.readFileSync(planPath), original, 'the plan was never rewritten');

  const recorded = readStream(w.ledger('runs', `${run}.jsonl`)).find((e) => e.kind === 'result.recorded');
  assert.equal(recorded.case_ref.row_hash, rows.rows[1].row_hash, 'the result pins the row it was run against');
  assert.equal(readStream(w.ledger('runs', `${run}.jsonl`))[0].plan_refs[0].fingerprint, rows.fingerprint);

  // A later plan edit (e.g. /sync-qa-test-plan) changes only the edited row's hash.
  fs.writeFileSync(planPath, original.toString().replace('The confirmation screen appears', 'The receipt screen appears'));
  const edited = w.ok('plan', 'rows', '--plan', 'checkout/test-plan.md').rows;
  assert.notEqual(edited[1].row_hash, rows.rows[1].row_hash);
  assert.equal(edited[0].row_hash, rows.rows[0].row_hash);
  assert.equal(w.ok('validate').errors.length, 0, 'history stays valid after a plan edit');
});

// ---------- 14. old flows ----------

function xlsxEntryDigest(file) {
  // Digest of the decompressed zip entries, so the check survives a zlib upgrade.
  const buf = fs.readFileSync(file);
  const h = crypto.createHash('sha256');
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const size = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString();
    const start = off + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + size);
    h.update(name).update('\0').update(method === 8 ? zlib.inflateRawSync(data) : data).update('\0');
    off = start + size;
  }
  return h.digest('hex');
}

test('14 existing QA flows are untouched: xlsx export is identical and no old flow calls the ledger', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-xlsx-'));
  const out = path.join(tmp, 'test-cases.xlsx');
  const r = spawnSync(process.execPath, [path.join(HERE, 'build-test-cases-xlsx.mjs'), path.join(HERE, 'fixtures', 'xlsx', 'sample-test-cases.json'), out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // Recorded from the unmodified builder at 8ff033c.
  assert.equal(xlsxEntryDigest(out), 'c5357b43b5ad24f3f2547a70c87a71c3bbe39dab48b040859fb932d004620bf6');

  for (const dir of ['commands', 'agents', 'skills', 'templates']) {
    for (const f of fs.readdirSync(path.join(PLUGIN_ROOT, dir), { recursive: true })) {
      const p = path.join(PLUGIN_ROOT, dir, f);
      if (!fs.statSync(p).isFile()) continue;
      assert.ok(!fs.readFileSync(p, 'utf8').includes('qa-ledger'), `${dir}/${f} must not be wired to the ledger in Stage 1`);
    }
  }
});

// ---------- 15. validation ----------

test('15 validation catches malformed and corrupt ledger data', () => {
  const corrupt = (mutate) => {
    const w = seeded();
    const run = openRun(w, 'functional', '103');
    w.ok('result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'fail');
    w.ok('result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'pass');
    w.ok('run', 'close', '--run', run);
    assert.equal(w.ok('validate').errors.length, 0);
    mutate(w, w.ledger('runs', `${run}.jsonl`), run);
    const res = w.cli('validate');
    assert.notEqual(res.code, 0, 'validate fails');
    return { w, codes: res.json.errors.map((e) => e.code) };
  };

  let r = corrupt((w, f) => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"result":"fail"', '"result":"pass"')));
  assert.ok(r.codes.includes('HASH_MISMATCH'), r.codes);

  r = corrupt((w, f) => {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.splice(1, 1);
    fs.writeFileSync(f, lines.join('\n'));
  });
  assert.ok(r.codes.includes('CHAIN_BROKEN'), r.codes);

  r = corrupt((w, f) => {
    // A correctly sealed and chained record appended after the close is still refused.
    const recs = readStream(f);
    const last = recs[recs.length - 1];
    recs.push(sealed({ ...recs[1], seq: last.seq + 1, prev: last.hash, result_id: `${recs[0].run_id}/${last.seq + 1}`, at: '2026-09-02T00:00:00.000Z' }));
    writeStream(f, recs);
  });
  assert.ok(r.codes.includes('EVENT_AFTER_TERMINAL'), r.codes);

  r = corrupt((w, f) => fs.appendFileSync(f, '{not json\n'));
  assert.ok(r.codes.includes('PARSE_ERROR'), r.codes);

  r = corrupt((w, f) => {
    const recs = readStream(f);
    recs[1] = sealed({ ...recs[1], result: 'passed' });
    for (let i = 2; i < recs.length; i++) recs[i] = sealed({ ...recs[i], prev: recs[i - 1].hash });
    writeStream(f, recs);
  });
  assert.ok(r.codes.includes('INVALID_RECORD'), r.codes);

  r = corrupt((w) => fs.writeFileSync(w.ledger('builds', '104.json'), fs.readFileSync(w.ledger('builds', '104.json'), 'utf8').replace('2.4.0-104', '2.4.1-104')));
  assert.ok(r.codes.includes('HASH_MISMATCH'), r.codes);

  r = corrupt((w) => fs.renameSync(w.ledger('builds', '105.json'), w.ledger('builds', '106.json')));
  assert.ok(r.codes.includes('ID_MISMATCH'), r.codes);

  r = corrupt((w) => fs.rmSync(w.ledger('builds', '103.json')));
  assert.ok(r.codes.includes('DANGLING_REFERENCE'), r.codes);

  r = corrupt((w) => {
    const f = w.ledger('scopes', 'feature', 'checkout.jsonl');
    const recs = readStream(f);
    const last = recs[recs.length - 1];
    recs.push(sealed({ v: 1, seq: last.seq + 1, prev: last.hash, at: '2026-09-02T00:00:00.000Z', kind: 'signoff.recorded', by: 'x' }));
    writeStream(f, recs);
  });
  assert.ok(r.codes.includes('UNKNOWN_EVENT_KIND'), r.codes);

  r = corrupt((w) => fs.writeFileSync(w.ledger('ledger.json'), JSON.stringify({ qa_ledger_schema: 2 })));
  assert.ok(r.codes.includes('UNSUPPORTED_SCHEMA'), r.codes);

  // Writes refuse to extend a corrupt stream.
  const { w } = corrupt((w, f) => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"result":"fail"', '"result":"pass"')));
  const scopeFile = w.ledger('scopes', 'feature', 'checkout.jsonl');
  fs.writeFileSync(scopeFile, fs.readFileSync(scopeFile, 'utf8').replace('"by":"dana"', '"by":"eve"'));
  w.refused('CORRUPT_STREAM', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'notes', '--value', '"x"', '--by', 'dana');
});

// ---------- 16. write boundary ----------

test('16 the helper never writes outside <qa-repo>/qa-ledger', () => {
  const w = workspace();
  const outsideBefore = snapshot(w.ws, (rel) => rel === 'acme-qa' || rel.startsWith(`acme-qa${path.sep}`));
  const qaBefore = snapshot(w.qa, (rel) => rel.startsWith('qa-ledger'));

  w.ok('init');
  w.refused('INVALID_ID', 'scope', 'create', '--scope', 'feature:../../acme-app/evil', '--created-by', 'x');
  w.refused('INVALID_ID', 'scope', 'create', '--scope', 'bug:..', '--created-by', 'x');
  w.refused('INVALID_ID', 'build', 'add', '--id', '../../escape', '--surfaces', 'android', '--registered-by', 'x');
  w.refused('INVALID_ID', 'build', 'add', '--id', 'ok', '--surfaces', '../x', '--registered-by', 'x');
  w.refused('PATH_OUTSIDE_QA_REPO', 'plan', 'rows', '--plan', '../acme-app/App.tsx');
  w.refused('PATH_OUTSIDE_QA_REPO', 'plan', 'rows', '--plan', '/etc/hosts');
  w.ok('scope', 'create', '--scope', 'feature:checkout', '--created-by', 'x');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'dev_artifacts', '--value', '{"kind":"qa_handoff","ref":"../acme-app/docs/qa/checkout-qa-handoff.md"}', '--by', 'x');

  assert.deepEqual(snapshot(w.ws, (rel) => rel === 'acme-qa' || rel.startsWith(`acme-qa${path.sep}`)), outsideBefore, 'nothing outside the QA repo changed');
  assert.deepEqual(snapshot(w.qa, (rel) => rel.startsWith('qa-ledger')), qaBefore, 'nothing in the QA repo outside qa-ledger changed');

  // A symlinked ledger (or ledger subfolder) pointing elsewhere is refused.
  const elsewhere = path.join(w.ws, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.rmSync(w.ledger('builds'), { recursive: true, force: true });
  fs.symlinkSync(elsewhere, w.ledger('builds'));
  w.refused('SYMLINK_REFUSED', 'build', 'add', '--id', '1', '--surfaces', 'android', '--registered-by', 'x');
  fs.rmSync(w.ledger(), { recursive: true });
  fs.symlinkSync(elsewhere, w.ledger());
  w.refused('SYMLINK_REFUSED', 'init');
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was written through a symlink');

  // Only a QA repo is accepted: not the code repo, not this plugin's repo, not a loose folder.
  const fx = workspace();
  fs.mkdirSync(path.join(fx.qa, '.ono'));
  fx.refused('NOT_A_QA_REPO', 'init');
  const fy = workspace();
  fs.mkdirSync(path.join(fy.qa, '.claude-plugin'));
  fs.writeFileSync(path.join(fy.qa, '.claude-plugin', 'plugin.json'), '{"name":"ono-plugin-qa"}');
  fy.refused('NOT_A_QA_REPO', 'init');
  const fz = workspace();
  fs.rmSync(path.join(fz.qa, '.git'), { recursive: true });
  fz.refused('NOT_A_QA_REPO', 'init');
  const missing = spawnSync(process.execPath, [HELPER, 'init'], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0, '--qa-repo is required');
});

// ---------- 17. repeated fix / re-test cycles ----------

test('17 repeated fix → re-test FAIL → fix → re-test PASS cycles need no schema change', () => {
  const w = workspace();
  w.ok('init');
  const schemaBefore = fs.readFileSync(w.ledger('ledger.json'));
  w.ok('scope', 'create', '--scope', 'bug:BUG-27', '--created-by', 'dana');
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'add', '--field', 'cases', '--value', '{"id":"R1","summary":"Resume playback after background"}', '--by', 'dana');
  const outcomes = { 'atv-104': 'fail', 'atv-105': 'fail', 'atv-106': 'pass' };
  w.ok('build', 'add', '--id', 'atv-103', '--surfaces', 'android-tv', '--registered-by', 'dana');
  const repro = w.ok('run', 'open', '--type', 'reproduction', '--scope', 'bug:BUG-27', '--build', 'atv-103', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana').run_id;
  w.ok('result', 'add', '--run', repro, '--case', 'bug:BUG-27#R1', '--result', 'fail');
  w.ok('run', 'close', '--run', repro);
  for (const [build, result] of Object.entries(outcomes)) {
    w.ok('build', 'add', '--id', build, '--surfaces', 'android-tv', '--registered-by', 'dana', '--related-scope', 'bug:BUG-27');
    w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'add', '--field', 'dev_artifacts', '--value', JSON.stringify({ kind: 'fix_build', ref: build }), '--by', 'dana');
    const run = w.ok('run', 'open', '--type', 'retest', '--scope', 'bug:BUG-27', '--build', build, '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana').run_id;
    const id = w.ok('result', 'add', '--run', run, '--case', 'bug:BUG-27#R1', '--result', result).result_id;
    w.ok('run', 'close', '--run', run);
    w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'add', '--field', 'result_refs', '--value', JSON.stringify(id), '--by', 'dana');
  }
  const history = w.ok('view', 'case-history', '--case', 'bug:BUG-27#R1').history;
  assert.deepEqual(history.map((h) => [h.build_id, h.type, h.result]), [
    ['atv-103', 'reproduction', 'fail'],
    ['atv-104', 'retest', 'fail'],
    ['atv-105', 'retest', 'fail'],
    ['atv-106', 'retest', 'pass'],
  ]);
  const scope = w.ok('view', 'scope', '--scope', 'bug:BUG-27').scope;
  assert.equal(scope.context.result_refs.length, 3);
  assert.deepEqual(scope.builds, ['atv-103', 'atv-104', 'atv-105', 'atv-106']);
  assert.deepEqual(fs.readFileSync(w.ledger('ledger.json')), schemaBefore, 'the schema record never changed');
  assert.equal(w.ok('validate').errors.length, 0);
});

// ---------- derived views ----------

test('18 derived views: scope context set/add/retract, runs per build, latest build per scope', () => {
  const w = seeded();
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'devices', '--value', '[{"surface":"android","device":"Pixel 8","os_runtime":"Android 15"}]', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'capability', '--value', '"checkout"', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'debt', '--value', '{"id":"D1","description":"VoiceOver walkthrough of Payment"}', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'debt', '--value', '{"id":"D2","description":"TalkBack walkthrough"}', '--by', 'dana');
  w.refused('DUPLICATE_VALUE', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'add', '--field', 'debt', '--value', '{"id":"D1","description":"again"}', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'retract', '--field', 'debt', '--value', '"D2"', '--by', 'dana', '--reason', 'Duplicate of D1');
  w.refused('NOT_PRESENT', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'retract', '--field', 'debt', '--value', '"D9"', '--by', 'dana', '--reason', 'x');
  w.refused('MISSING_ARGUMENT', 'scope', 'event', '--scope', 'feature:checkout', '--op', 'retract', '--field', 'debt', '--value', '"D1"', '--by', 'dana');
  const ctx = w.ok('view', 'scope', '--scope', 'feature:checkout').scope.context;
  assert.equal(ctx.capability, 'checkout');
  assert.deepEqual(ctx.debt.map((d) => d.id), ['D1']);
  assert.equal(ctx.devices[0].device, 'Pixel 8');

  w.ok('scope', 'create', '--scope', 'release:2.4.0', '--created-by', 'dana');
  w.ok('scope', 'event', '--scope', 'release:2.4.0', '--op', 'add', '--field', 'members', '--value', '"feature:checkout"', '--by', 'dana');
  assert.deepEqual(w.ok('view', 'scope', '--scope', 'release:2.4.0').scope.context.members, ['feature:checkout']);

  w.ok('build', 'add', '--id', 'ios-9', '--surfaces', 'ios', '--registered-by', 'dana');
  const a = openRun(w, 'smoke', '104');
  const b = openRun(w, 'functional', '104');
  openRun(w, 'functional', '105');
  assert.deepEqual(w.ok('view', 'runs', '--build', '104').runs.map((r) => r.run_id), [a, b]);
  assert.equal(w.ok('view', 'latest-build', '--surface', 'ios').build.build_id, 'ios-9');
  assert.equal(w.ok('view', 'latest-build', '--surface', 'ios', '--scope', 'feature:checkout').build.build_id, '105', 'ios-9 is not related to the scope');
  assert.equal(w.ok('view', 'latest-build', '--surface', 'tvos').build, null);
  assert.deepEqual(w.ok('view', 'builds', '--scope', 'feature:checkout').builds.map((x) => x.build_id), ['103', '104', '105']);
  w.ok('result', 'add', '--run', b, '--case', 'checkout/TC1', '--result', 'fail');
  const lr = w.ok('view', 'latest-result', '--case', 'checkout/TC1', '--surface', 'android');
  assert.equal(lr.latest, null, 'open runs are provisional and never count as the latest result');
  assert.equal(lr.excluded_open, 1);
  assert.equal(lr.history_count, 1, 'the provisional result is still visible in history');
});

test('19 init is idempotent and validate on a fresh ledger is clean', () => {
  const w = workspace();
  const first = w.ok('init');
  assert.equal(first.created, true);
  const ledgerJson = fs.readFileSync(w.ledger('ledger.json'));
  assert.equal(w.ok('init').created, false);
  assert.deepEqual(fs.readFileSync(w.ledger('ledger.json')), ledgerJson);
  const v = w.ok('validate');
  assert.deepEqual(v.errors, []);
  const other = workspace();
  other.refused('LEDGER_NOT_INITIALIZED', 'validate');
  other.refused('LEDGER_NOT_INITIALIZED', 'build', 'add', '--id', '1', '--surfaces', 'ios', '--registered-by', 'x');
  other.refused('DUPLICATE_ARGUMENT', 'init', '--qa-repo', other.qa);
  assert.equal(fs.existsSync(other.ledger()), false, 'nothing is created before init');
});

test('20 an aborted run is kept in history but never counts as the latest result', () => {
  const w = seeded();
  const closed = openRun(w, 'functional', '103');
  w.ok('result', 'add', '--run', closed, '--case', 'checkout/TC14', '--result', 'fail');
  w.ok('run', 'close', '--run', closed);
  const aborted = openRun(w, 'functional', '104');
  w.ok('result', 'add', '--run', aborted, '--case', 'checkout/TC14', '--result', 'pass');
  w.ok('run', 'abort', '--run', aborted, '--reason', 'Wrong build installed');
  const lr = w.ok('view', 'latest-result', '--case', 'checkout/TC14', '--surface', 'android');
  assert.equal(lr.latest.result, 'fail');
  assert.equal(lr.latest.build_id, '103');
  assert.equal(lr.excluded_aborted, 1);
  const history = w.ok('view', 'case-history', '--case', 'checkout/TC14').history;
  assert.deepEqual(history.map((h) => [h.build_id, h.run_state, h.result]), [
    ['103', 'closed', 'fail'],
    ['104', 'aborted', 'pass'],
  ]);
});
