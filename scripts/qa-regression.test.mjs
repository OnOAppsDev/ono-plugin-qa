// Tests for QA lifecycle Stage 5 — Project Knowledge + regression. Project Knowledge
// is read through the vendored Dev-plugin reader (scripts/vendor/read-repo-knowledge.ts)
// from a real git code repo, so freshness and evidence re-checks are the reader's own.
//
// Run: node --test scripts/qa-regression.test.mjs
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
const PK_FIX = path.join(HERE, 'fixtures', 'pk-repo');
const DEV_FIX = path.join(HERE, 'fixtures', 'dev-repo');

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

function workspace({ pk = true } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-regression-test-')));
  const qa = path.join(ws, 'acme-qa');
  const code = path.join(ws, 'acme-app');
  fs.mkdirSync(path.join(qa, '.git'), { recursive: true });
  for (const f of ['checkout/test-plan.md', 'cart/test-plan.md', 'smoke/android/smoke-suite.md', 'smoke/android-tv/smoke-suite.md', 'automation/tests/cart/cart.spec.js']) {
    fs.mkdirSync(path.dirname(path.join(qa, f)), { recursive: true });
    fs.copyFileSync(path.join(QA_FIX, f), path.join(qa, f));
  }
  fs.cpSync(PK_FIX, code, { recursive: true });
  fs.cpSync(DEV_FIX, code, { recursive: true });
  const template = path.join(code, '.ono', 'repo-knowledge.template.json');
  const manifest = fs.readFileSync(template, 'utf8');
  fs.rmSync(path.join(code, '.ono'), { recursive: true });
  git(code, 'init', '-q');
  git(code, 'add', '-A');
  git(code, 'commit', '-qm', 'app');
  const stamp = () => {
    fs.mkdirSync(path.join(code, '.ono'), { recursive: true });
    fs.writeFileSync(path.join(code, '.ono', 'repo-knowledge.json'), manifest.replaceAll('__HEAD__', git(code, 'rev-parse', 'HEAD')));
  };
  if (pk) stamp();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 20, 9, 0, 0) + tick++ * 1000).toISOString();
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
  // Commit a source change after the knowledge was generated → the reader sees drift.
  const drift = (rel, from, to) => {
    const f = path.join(code, rel);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(from, to));
    git(code, 'commit', '-qam', 'change');
  };
  const ledger = (...p) => path.join(qa, 'qa-ledger', ...p);
  return { ws, qa, code, cli, ok, refused, drift, ledger };
}

// feature:checkout bound (Stage 4) to Dev feature checkout / capability checkout-payments,
// plus feature:cart bound to capability cart; builds 104/105 on android.
function featureSetup(opts) {
  const w = workspace(opts);
  w.ok('init');
  for (const f of ['checkout', 'cart']) w.ok('scope', 'create', '--scope', `feature:${f}`, '--created-by', 'dana');
  w.ok('handoff', 'ingest', '--scope', 'feature:checkout', '--code-repo', w.code, '--by', 'dana', '--feature', 'checkout');
  w.ok('scope', 'event', '--scope', 'feature:cart', '--op', 'add', '--field', 'plans', '--value', '"cart/test-plan.md"', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:cart', '--op', 'set', '--field', 'capability', '--value', '"cart"', '--by', 'dana');
  for (const b of ['104', '105']) w.ok('build', 'add', '--id', b, '--surfaces', 'android', '--registered-by', 'dana', '--related-scope', 'feature:checkout');
  return w;
}
const candidates = (w, scope = 'feature:checkout', ...extra) => w.ok('regression', 'candidates', '--scope', scope, '--code-repo', w.code, ...extra);
const decide = (w, ...args) => w.ok('regression', 'decide', '--scope', 'feature:checkout', '--code-repo', w.code, '--by', 'dana', ...args);
const standardDecision = (w) =>
  decide(w, '--required', 'yes', '--reason', 'Cart shares state with checkout', '--include', 'cart', '--exclude', 'payment-service=Covered by its own unit tests', '--exclude', 'wallet=Only a doc reference; no shared code path', '--case', 'cart/TC1', '--case', 'checkout/TC1', '--target', '104@android').decision;
function smokePass(w, build, surface = 'android', scope = 'feature:checkout') {
  const run = w.ok('run', 'open', '--type', 'smoke', '--scope', scope, '--build', build, '--surface', surface, '--device', 'Device', '--executor', 'dana', '--plan', `smoke/${surface}/smoke-suite.md`).run_id;
  for (const c of w.ok('view', 'run-cases', '--run', run).cases) w.ok('result', 'add', '--run', run, '--case', c.case_key, '--result', 'pass');
  w.ok('run', 'close', '--run', run);
}
const openRegression = (w, build, decision = 'RD-1', scope = 'feature:checkout', surface = 'android') => w.ok('run', 'open', '--type', 'regression', '--scope', scope, '--build', build, '--surface', surface, '--device', 'Pixel 8', '--executor', 'dana', '--decision', decision).run_id;
const ids = (list) => list.map((c) => c.capability);

// ---------- planning isolation ----------

test('S5-01 QA test planning and sync never consume Project Knowledge', () => {
  const planning = ['commands/create-qa-test-plan.md', 'commands/sync-qa-test-plan.md', 'skills/qa-test-planning/SKILL.md', 'skills/qa-test-plan-sync/SKILL.md', 'agents/qa-test-designer.md', 'agents/qa-test-plan-syncer.md'];
  for (const f of planning) {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, f), 'utf8');
    for (const needle of ['repo-knowledge', 'Project Knowledge', 'qa-ledger', 'regression', 'knowledge lookup', 'capabilit']) assert.ok(!text.toLowerCase().includes(needle.toLowerCase()), `${f} must not reference ${needle}`);
  }
  const cmd = fs.readFileSync(path.join(PLUGIN_ROOT, 'commands', 'plan-regression.md'), 'utf8');
  assert.match(cmd, /never (writes?|authors?|adds?) (a )?test[- ]plan case/i, '/plan-regression states that Project Knowledge never authors test cases');
  const doc = fs.readFileSync(path.join(PLUGIN_ROOT, 'docs', 'qa-project-knowledge.md'), 'utf8');
  assert.match(doc, /Planning isolation/);
});

// ---------- fallback ----------

test('S5-02 a code repo without Project Knowledge still supports manual regression planning', () => {
  const w = featureSetup({ pk: false });
  const c = candidates(w);
  assert.equal(c.knowledge.available, false);
  assert.equal(c.knowledge.reason, 'absent');
  assert.deepEqual(c.candidates, []);
  assert.match(c.note, /manual/i);
  const d = decide(w, '--required', 'yes', '--reason', 'Manual: cart shares the basket', '--candidate', 'cart', '--include', 'cart', '--case', 'cart/TC1', '--target', '104@android').decision;
  assert.deepEqual([d.candidates, d.included, d.knowledge.available], [['cart'], ['cart'], false]);
  assert.equal(w.ok('view', 'regression', '--scope', 'feature:checkout').current.id, 'RD-1');
});

// ---------- capability identity ----------

test('S5-03 a feature scope uses the exact capability bound in Stage 4 — no fuzzy matching', () => {
  const w = featureSetup();
  const c = candidates(w);
  assert.deepEqual(c.capability, { id: 'checkout-payments', source: 'scope', status: 'found', matched_by: 'id' });
});

function standaloneBug(w) {
  w.ok('bug', 'report', '--id', 'BUG-27', '--title', 'Player freezes after resume', '--step', 'Start a movie', '--step', 'Resume after 30 s', '--expected', 'Playback resumes', '--actual', 'Frozen frame', '--severity', 'major', '--surfaces', 'android-tv', '--by', 'dana');
}

test('S5-04 a standalone bug binds to a capability by exact identity', () => {
  const w = workspace();
  w.ok('init');
  standaloneBug(w);
  assert.equal(candidates(w, 'bug:BUG-27').capability.status, 'none', 'nothing is guessed for an unbound bug');
  const found = w.ok('knowledge', 'lookup', '--code-repo', w.code, '--capability', 'Video Playback');
  assert.deepEqual(found.lookup.matches, [{ id: 'playback', matchedBy: 'name' }]);
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'set', '--field', 'capability', '--value', '"playback"', '--by', 'dana');
  const c = candidates(w, 'bug:BUG-27');
  assert.equal(c.capability.id, 'playback');
  assert.deepEqual(ids(c.candidates), ['home-rows']);
  assert.equal(w.ok('view', 'bug', '--bug', 'bug:BUG-27').bug.capability, 'playback');
});

test('S5-05 exact lookup works by id, exact name and path — never by similarity', () => {
  const w = workspace();
  const look = (...a) => w.ok('knowledge', 'lookup', '--code-repo', w.code, ...a).lookup;
  assert.deepEqual(look('--capability', 'wallet').matches, [{ id: 'wallet', matchedBy: 'id' }]);
  assert.deepEqual(look('--capability', 'checkout   PAYMENTS').matches, [{ id: 'checkout-payments', matchedBy: 'name' }]);
  assert.deepEqual(look('--path', 'src/player/Player.tsx').matches, [{ id: 'playback', matchedBy: 'source-root' }]);
  assert.equal(look('--capability', 'video').status, 'not-found');
  const surface = w.ok('knowledge', 'lookup', '--code-repo', w.code, '--surface', 'tv-app').surface;
  assert.equal(surface.status, 'found');
  assert.equal(surface.surface.formFactor, 'tv');
});

test('S5-06 an ambiguous match is never auto-selected', () => {
  const w = featureSetup();
  const l = w.ok('knowledge', 'lookup', '--code-repo', w.code, '--capability', 'cart').lookup;
  assert.equal(l.status, 'ambiguous');
  assert.deepEqual(l.matches.map((m) => m.id), ['cart', 'mini-cart']);
  const c = candidates(w, 'feature:checkout', '--capability', 'cart');
  assert.equal(c.capability.status, 'ambiguous');
  assert.deepEqual(c.capability.matches.map((m) => m.id), ['cart', 'mini-cart']);
  assert.deepEqual(c.candidates, []);
  w.refused('CAPABILITY_AMBIGUOUS', 'regression', 'decide', '--scope', 'feature:checkout', '--code-repo', w.code, '--by', 'dana', '--capability', 'cart', '--required', 'no', '--reason', 'x');
});

// ---------- relationships ----------

test('S5-07 first-degree relationships load as candidates', () => {
  const w = featureSetup();
  const c = candidates(w);
  assert.deepEqual(ids(c.candidates), ['cart', 'payment-service', 'wallet']);
  const cart = c.candidates.find((x) => x.capability === 'cart');
  assert.deepEqual(cart.relationships.map((r) => [r.id, r.type, r.direction, r.evidence_kind, r.evidence_status]), [['cart:shares_state_with:checkout-payments', 'shares_state_with', 'incoming', 'shared-state', 'verified']]);
});

test('S5-08 no second-degree or transitive relationship is ever loaded', () => {
  const w = featureSetup();
  const c = candidates(w);
  assert.ok(!ids(c.candidates).includes('profile'), 'profile is only reachable through payment-service');
  const all = JSON.stringify(c);
  assert.ok(!all.includes('payment-service:used_by:profile'), 'the neighbour’s own edges are never read');
  for (const cand of c.candidates) for (const r of cand.relationships) assert.ok(r.id.split(':').includes('checkout-payments'), `${r.id} touches the capability under test`);
  assert.ok(c.candidates.every((x) => !('score' in x) && !('rank' in x) && !('confidence' in x)), 'no scoring');
});

test('S5-09 stale relationship evidence is re-checked against the current source', () => {
  const w = featureSetup();
  w.drift('src/cart/CartScreen.tsx', /useCart/g, 'useBasket');
  const c = candidates(w);
  assert.equal(c.knowledge.capabilities, 'verifyOnUse', 'source moved since the knowledge was generated');
  assert.ok(!ids(c.candidates).includes('cart'), 'the cart edge no longer holds');
  const dropped = c.dropped_relationships.find((d) => d.id === 'cart:shares_state_with:checkout-payments');
  assert.match(dropped.reason, /useCart/);
  assert.deepEqual(ids(c.candidates), ['payment-service', 'wallet'], 'edges that still hold are kept');
});

test('S5-10 failed evidence is never presented as verified context — even on fresh knowledge', () => {
  const w = featureSetup();
  const c = candidates(w);
  assert.equal(c.knowledge.capabilities, 'trusted');
  const dropped = c.dropped_relationships.map((d) => d.id);
  assert.deepEqual(dropped, ['checkout-payments:navigates_to:profile']);
  assert.ok(c.candidates.every((x) => x.relationships.every((r) => r.evidence_status === 'verified')));
  assert.match(c.dropped_relationships[0].reason, /openProfile/);
});

test('S5-11 related_to is advisory context only', () => {
  const w = featureSetup();
  const wallet = candidates(w).candidates.find((x) => x.capability === 'wallet');
  assert.equal(wallet.relationships[0].type, 'related_to');
  assert.equal(wallet.advisory, true);
  w.refused('UNADDRESSED_CANDIDATE', 'regression', 'decide', '--scope', 'feature:checkout', '--code-repo', w.code, '--by', 'dana', '--required', 'yes', '--reason', 'r', '--include', 'cart', '--exclude', 'payment-service=unit tests', '--case', 'cart/TC1', '--target', '104@android');
});

// ---------- QA decides ----------

test('S5-12 regression candidates never become scope on their own', () => {
  const w = featureSetup();
  candidates(w);
  candidates(w);
  assert.equal(w.ok('view', 'scope', '--scope', 'feature:checkout').scope.context.regression_decisions, undefined);
  assert.equal(w.ok('view', 'regression', '--scope', 'feature:checkout').current, null);
});

test('S5-13 QA can decide regression is not required — with a mandatory reason', () => {
  const w = featureSetup();
  const base = ['regression', 'decide', '--scope', 'feature:checkout', '--code-repo', w.code, '--by', 'dana'];
  const excludeAll = ['--exclude', 'cart=Unchanged', '--exclude', 'payment-service=Unchanged', '--exclude', 'wallet=Unchanged'];
  w.refused('MISSING_ARGUMENT', ...base, ...excludeAll, '--required', 'no');
  w.refused('MISSING_ARGUMENT', ...base, ...excludeAll, '--reason', 'r');
  w.refused('INVALID_VALUE', ...base, ...excludeAll, '--required', 'maybe', '--reason', 'r');
  w.refused('INVALID_VALUE', ...base, ...excludeAll, '--required', 'no', '--reason', 'r', '--case', 'cart/TC1');
  const d = decide(w, ...excludeAll, '--required', 'no', '--reason', 'Isolated copy change; no shared code touched').decision;
  assert.equal(d.required, false);
  assert.equal(d.reason, 'Isolated copy change; no shared code touched');
  w.refused('REGRESSION_NOT_REQUIRED', 'run', 'open', '--type', 'regression', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--decision', 'RD-1');
});

test('S5-14 QA selects a subset of candidates', () => {
  const w = featureSetup();
  const d = standardDecision(w);
  assert.deepEqual(d.candidates, ['cart', 'payment-service', 'wallet']);
  assert.deepEqual(d.included, ['cart']);
  assert.deepEqual(d.excluded.map((x) => x.capability), ['payment-service', 'wallet']);
  assert.deepEqual(d.cases, ['cart/TC1', 'checkout/TC1']);
  assert.deepEqual(d.targets, [{ build_id: '104', surface: 'android' }]);
});

test('S5-15 an excluded candidate always carries its reason', () => {
  const w = featureSetup();
  const base = ['regression', 'decide', '--scope', 'feature:checkout', '--code-repo', w.code, '--by', 'dana', '--required', 'no', '--reason', 'r', '--exclude', 'cart=x', '--exclude', 'payment-service=x'];
  w.refused('MISSING_ARGUMENT', ...base, '--exclude', 'wallet');
  w.refused('MISSING_ARGUMENT', ...base, '--exclude', 'wallet=  ');
  w.refused('INVALID_VALUE', 'regression', 'decide', '--scope', 'feature:checkout', '--code-repo', w.code, '--by', 'dana', '--required', 'yes', '--reason', 'r', '--include', 'cart', '--exclude', 'cart=x', '--exclude', 'payment-service=x', '--exclude', 'wallet=x', '--case', 'cart/TC1', '--target', '104@android');
  w.refused('UNKNOWN_CANDIDATE', ...base, '--exclude', 'wallet=x', '--exclude', 'profile=not a direct candidate');
  const d = decide(w, '--required', 'no', '--reason', 'r', '--exclude', 'cart=Unchanged', '--exclude', 'payment-service=Own tests', '--exclude', 'wallet=Doc only').decision;
  assert.deepEqual(d.excluded, [
    { capability: 'cart', reason: 'Unchanged' },
    { capability: 'payment-service', reason: 'Own tests' },
    { capability: 'wallet', reason: 'Doc only' },
  ]);
});

// ---------- existing coverage ----------

test('S5-16 existing QA coverage is surfaced when known', () => {
  const w = featureSetup();
  const c = candidates(w);
  const cart = c.candidates.find((x) => x.capability === 'cart').existing_coverage;
  assert.deepEqual(cart.qa_scopes, ['feature:cart']);
  assert.deepEqual(cart.qa_cases.map((x) => [x.case_key, x.plan_status]), [
    ['cart/TC1', 'approved'],
    ['cart/TC2', 'approved'],
  ]);
  assert.deepEqual(cart.automation, ['automation/tests/cart/cart.spec.js']);
  assert.equal(cart.known, true);
  const svc = c.candidates.find((x) => x.capability === 'payment-service').existing_coverage;
  assert.deepEqual(svc.code_tests, ['src/payments/paymentService.test.ts'], 'Project Knowledge test evidence is shown, never turned into QA cases');
  assert.deepEqual(svc.qa_cases, []);
  assert.deepEqual(c.capability_coverage.qa_cases.map((x) => x.case_key).slice(0, 2), ['checkout/TC1', 'checkout/TC14'], 'the capability under test shows its own coverage too');
});

test('S5-17 missing coverage is reported, never invented', () => {
  const w = featureSetup();
  const wallet = candidates(w).candidates.find((x) => x.capability === 'wallet').existing_coverage;
  assert.deepEqual(wallet, { known: false, qa_scopes: [], qa_cases: [], automation: [], code_tests: [], note: 'No existing QA or automated coverage is known for this capability — QA selects or writes cases manually.' });
});

// ---------- decision ----------

test('S5-18 the regression decision persists in the ledger scope', () => {
  const w = featureSetup();
  standardDecision(w);
  const stream = fs.readFileSync(w.ledger('scopes', 'feature', 'checkout.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ev = stream.find((e) => e.field === 'regression_decisions');
  assert.equal(ev.kind, 'context.add');
  assert.equal(ev.value.id, 'RD-1');
  const view = w.ok('view', 'regression', '--scope', 'feature:checkout');
  assert.equal(view.current.decided_by, 'dana');
  assert.equal(view.current.decided_at, ev.at);
  assert.equal(view.current.capability, 'checkout-payments');
  assert.deepEqual(view.current.knowledge, { available: true, freshness: 'fresh', capabilities: 'trusted' });
  assert.equal(w.ok('validate').errors.length, 0);
});

// ---------- execution ----------

test('S5-19 regression execution uses the Stage 2 run model', () => {
  const w = featureSetup();
  standardDecision(w);
  smokePass(w, '104');
  const run = openRegression(w, '104');
  w.ok('result', 'add', '--run', run, '--case', 'cart/TC1', '--result', 'pass');
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC1', '--result', 'blocked', '--notes', 'Staging payments down');
  w.ok('run', 'close', '--run', run);
  const header = JSON.parse(fs.readFileSync(w.ledger('runs', `${run}.jsonl`), 'utf8').split('\n')[0]);
  assert.equal(header.execution_type, 'regression');
  assert.equal(header.regression_decision, 'RD-1');
  assert.deepEqual(header.plan_refs.map((p) => p.plan), ['cart/test-plan.md', 'checkout/test-plan.md'], 'plans come from the decision');
  assert.deepEqual(w.ok('view', 'case-history', '--case', 'cart/TC1').history.map((h) => [h.type, h.build_id, h.result]), [['regression', '104', 'pass']]);
  const status = w.ok('view', 'regression', '--scope', 'feature:checkout').status;
  assert.deepEqual(status.targets[0].cases.map((c) => [c.case_key, c.status]), [
    ['cart/TC1', 'pass'],
    ['checkout/TC1', 'blocked'],
  ]);
});

test('S5-20 regression execution requires the Stage 2 smoke gate of its build and surface', () => {
  const w = featureSetup();
  standardDecision(w);
  const r = w.refused('SMOKE_GATE_CLOSED', 'run', 'open', '--type', 'regression', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--decision', 'RD-1');
  assert.equal(r.error.details.smoke_status, 'not_started');
  smokePass(w, '104');
  openRegression(w, '104');
  w.refused('REGRESSION_DECISION_REQUIRED', 'run', 'open', '--type', 'regression', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana');
});

test('S5-21 regression execution records only the selected cases', () => {
  const w = featureSetup();
  standardDecision(w);
  smokePass(w, '104');
  const run = openRegression(w, '104');
  assert.deepEqual(w.ok('view', 'run-cases', '--run', run).cases.map((c) => c.case_key), ['cart/TC1', 'checkout/TC1']);
  w.refused('CASE_NOT_SELECTED', 'result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'pass');
  w.refused('CASE_NOT_SELECTED', 'result', 'add', '--run', run, '--case', 'cart/TC2', '--result', 'pass');
  w.refused('REGRESSION_PLAN_MISMATCH', 'run', 'open', '--type', 'regression', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--decision', 'RD-1', '--plan', 'checkout/test-plan.md');
});

test('S5-22 a regression FAIL stays a FAIL until QA explicitly reports a bug', () => {
  const w = featureSetup();
  standardDecision(w);
  smokePass(w, '104');
  const run = openRegression(w, '104');
  w.ok('result', 'add', '--run', run, '--case', 'cart/TC1', '--result', 'fail', '--notes', 'Cart badge shows 0');
  w.ok('run', 'close', '--run', run);
  assert.deepEqual(w.ok('view', 'bugs').bugs, []);
  const bug = w.ok('bug', 'report', '--id', 'BUG-40', '--from-run', run, '--case', 'cart/TC1', '--title', 'Cart badge resets', '--severity', 'minor', '--by', 'dana').bug;
  assert.equal(bug.state, 'assigned');
  assert.deepEqual(bug.linked_cases, ['cart/TC1']);
});

test('S5-23 a new build never inherits earlier regression evidence', () => {
  const w = featureSetup();
  standardDecision(w);
  smokePass(w, '104');
  smokePass(w, '105');
  const run = openRegression(w, '104');
  w.ok('result', 'add', '--run', run, '--case', 'cart/TC1', '--result', 'pass');
  w.ok('run', 'close', '--run', run);
  w.refused('REGRESSION_TARGET_MISMATCH', 'run', 'open', '--type', 'regression', '--scope', 'feature:checkout', '--build', '105', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--decision', 'RD-1');
  const status = w.ok('view', 'regression', '--scope', 'feature:checkout').status;
  assert.deepEqual(status.targets.map((t) => t.build_id), ['104'], 'build 105 is not silently satisfied');
  // An explicit new decision targets 105; its evidence starts empty.
  decide(w, '--required', 'yes', '--reason', 'Re-run on 105', '--include', 'cart', '--exclude', 'payment-service=x', '--exclude', 'wallet=x', '--case', 'cart/TC1', '--target', '105@android');
  const next = w.ok('view', 'regression', '--scope', 'feature:checkout');
  assert.equal(next.current.id, 'RD-2');
  assert.deepEqual(next.status.targets[0].cases.map((c) => c.status), ['pending']);
  w.refused('REGRESSION_DECISION_SUPERSEDED', 'run', 'open', '--type', 'regression', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--decision', 'RD-1');
  assert.equal(next.history.length, 2, 'the earlier decision stays in history');
});

test('S5-24 a standalone bug gets regression with no feature plan at all', () => {
  const w = workspace();
  w.ok('init');
  standaloneBug(w);
  w.ok('build', 'add', '--id', 'atv-103', '--surfaces', 'android-tv', '--registered-by', 'dana');
  w.ok('bug', 'verify', '--bug', 'bug:BUG-27', '--build', 'atv-103', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'reproduced');
  w.ok('build', 'add', '--id', 'atv-104', '--surfaces', 'android-tv', '--registered-by', 'omer', '--fixes', 'bug:BUG-27');
  smokePass(w, 'atv-104', 'android-tv', 'bug:BUG-27');
  w.ok('bug', 'retest', '--bug', 'bug:BUG-27', '--build', 'atv-104', '--surface', 'android-tv', '--device', 'Shield', '--executor', 'dana', '--outcome', 'pass');
  w.ok('scope', 'event', '--scope', 'bug:BUG-27', '--op', 'set', '--field', 'capability', '--value', '"playback"', '--by', 'dana');
  const c = candidates(w, 'bug:BUG-27');
  assert.deepEqual(ids(c.candidates), ['home-rows']);
  assert.equal(c.candidates[0].existing_coverage.known, false);
  w.refused('INVALID_VALUE', 'regression', 'decide', '--scope', 'bug:BUG-27', '--code-repo', w.code, '--by', 'dana', '--required', 'yes', '--reason', 'r', '--include', 'home-rows', '--case', 'bug:BUG-99#R1', '--target', 'atv-104@android-tv');
  const d = w.ok('regression', 'decide', '--scope', 'bug:BUG-27', '--code-repo', w.code, '--by', 'dana', '--required', 'yes', '--reason', 'Home rows open the player', '--include', 'home-rows', '--case', 'bug:BUG-27#R1', '--target', 'atv-104@android-tv').decision;
  assert.deepEqual(d.cases, ['bug:BUG-27#R1']);
  const run = openRegression(w, 'atv-104', 'RD-1', 'bug:BUG-27', 'android-tv');
  w.ok('result', 'add', '--run', run, '--case', 'bug:BUG-27#R1', '--result', 'pass');
  w.ok('run', 'close', '--run', run);
  assert.equal(w.ok('view', 'regression', '--scope', 'bug:BUG-27').status.targets[0].cases[0].status, 'pass');
  assert.equal(w.ok('view', 'bug', '--bug', 'bug:BUG-27').bug.state, 'closed_verified', 'regression never changes the bug state');
  assert.ok(!fs.existsSync(w.ledger('scopes', 'feature')), 'no feature was created');
});

// ---------- preservation ----------

test('S5-25 earlier stages are unchanged: non-regression runs keep their exact header shape', () => {
  const w = featureSetup();
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'surfaces', '--value', '["android"]', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'devices', '--value', '[{"surface":"android","device":"Pixel 8"}]', '--by', 'dana');
  smokePass(w, '104');
  const run = w.ok('run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '104', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'checkout/test-plan.md').run_id;
  const header = JSON.parse(fs.readFileSync(w.ledger('runs', `${run}.jsonl`), 'utf8').split('\n')[0]);
  assert.ok(!('regression_decision' in header));
  assert.equal(w.ok('validate').errors.length, 0);
});

test('S5-26 no readiness, S5-27 no release, S5-28 no automation applicability logic', () => {
  const w = featureSetup();
  for (const cmd of [['readiness'], ['signoff'], ['release'], ['view', 'readiness'], ['automation', 'applicability']]) w.refused('UNKNOWN_COMMAND', ...cmd, '--scope', 'feature:checkout');
  for (const name of fs.readdirSync(path.join(PLUGIN_ROOT, 'commands'))) assert.ok(!/readiness|sign-?off|release/i.test(name), name);
  for (const f of ['commands/generate-automation-scripts.md', 'skills/automation-test-generation/SKILL.md', 'agents/automation-test-writer.md']) {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, f), 'utf8');
    assert.ok(!/applicab|Project Knowledge|regression/i.test(text), `${f} is untouched by Stage 5`);
  }
  standardDecision(w);
  const out = JSON.stringify(w.ok('view', 'regression', '--scope', 'feature:checkout'));
  assert.ok(!/READY|verdict|sign_?off/i.test(out));
});

test('S5-29 validate catches a regression run outside its decision', () => {
  const w = featureSetup();
  standardDecision(w);
  smokePass(w, '104');
  smokePass(w, '105');
  const run = openRegression(w, '104');
  w.ok('result', 'add', '--run', run, '--case', 'cart/TC1', '--result', 'pass');
  w.ok('run', 'close', '--run', run);
  assert.equal(w.ok('validate').errors.length, 0);
  const f = w.ledger('runs', `${run}.jsonl`);
  const recs = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
  const seal = ({ hash, ...rest }) => ({ ...rest, hash: `sha256:${spawnSync('shasum', ['-a', '256'], { input: canonical(rest), encoding: 'utf8' }).stdout.split(' ')[0]}` });
  const forged = run.replace(/-[0-9a-f]{8}$/, '-0badf00d');
  const out = [];
  for (const r of recs) {
    const copy = { ...r, prev: out.length ? out[out.length - 1].hash : null };
    if (copy.kind === 'run.opened') Object.assign(copy, { run_id: forged, build_id: '105' });
    if (copy.result_id) copy.result_id = copy.result_id.replace(run, forged);
    out.push(seal(copy));
  }
  fs.writeFileSync(w.ledger('runs', `${forged}.jsonl`), out.map(canonical).join('\n') + '\n');
  const codes = w.cli('validate').json.errors.map((e) => e.code);
  assert.ok(codes.includes('REGRESSION_OUTSIDE_DECISION'), codes);
});

test('S5-30 validate re-derives the smoke gate for every regression run', () => {
  const w = featureSetup();
  standardDecision(w);
  smokePass(w, '104');
  const run = openRegression(w, '104');
  w.ok('result', 'add', '--run', run, '--case', 'cart/TC1', '--result', 'pass');
  w.ok('run', 'close', '--run', run);
  // Remove the smoke that opened the gate: the regression run no longer held it.
  const smoke = w.ok('view', 'smoke', '--build', '104', '--surface', 'android').surfaces[0].run_id;
  fs.rmSync(w.ledger('runs', `${smoke}.jsonl`));
  const codes = w.cli('validate').json.errors.map((e) => e.code);
  assert.ok(codes.includes('GATE_NOT_HELD'), codes);
});
