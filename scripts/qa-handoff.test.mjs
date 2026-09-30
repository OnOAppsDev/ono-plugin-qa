// Tests for QA lifecycle Stage 4 — Dev → QA handoff integration. The Dev plugin's
// artifacts (Task Breakdown, Feature Analysis, QA handoff) are read-only inputs from
// the code repo; the helper binds them into the existing feature scope.
//
// Run: node --test scripts/qa-handoff.test.mjs
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
const QA_FIXTURES = path.join(HERE, 'fixtures', 'qa-ledger');
const DEV_FIXTURE = path.join(HERE, 'fixtures', 'dev-repo');
const HANDOFF = 'docs/qa/checkout-qa-handoff.md';
const BREAKDOWN = 'docs/checkout-task-breakdown.md';
const ANALYSIS = 'docs/checkout-feature-analysis.md';
const SECTIONS = ['Feature Summary', 'How to Test', 'Test Accounts & Environment', 'Edge Cases', 'Known Limitations', 'Screens & Flows Touched', 'Build / Install / Testing Instructions', 'i18n / RTL Check', 'Accessibility Check', 'Pending Verification (owed to QA)'];

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = sha256(fs.readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

function workspace({ qaSlug = 'checkout' } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-handoff-test-')));
  const qa = path.join(ws, 'acme-qa');
  const code = path.join(ws, 'acme-app');
  fs.mkdirSync(path.join(qa, '.git'), { recursive: true });
  fs.mkdirSync(path.join(qa, qaSlug), { recursive: true });
  fs.copyFileSync(path.join(QA_FIXTURES, 'checkout', 'test-plan.md'), path.join(qa, qaSlug, 'test-plan.md'));
  for (const s of ['android', 'ios']) {
    fs.mkdirSync(path.join(qa, 'smoke', s), { recursive: true });
    fs.copyFileSync(path.join(QA_FIXTURES, 'smoke', s, 'smoke-suite.md'), path.join(qa, 'smoke', s, 'smoke-suite.md'));
  }
  fs.cpSync(DEV_FIXTURE, code, { recursive: true });
  fs.mkdirSync(path.join(code, '.git'));
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 12, 9, 0, 0) + tick++ * 1000).toISOString();
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
  const edit = (rel, from, to) => {
    const f = path.join(code, rel);
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(text.includes(from), `${rel} contains ${from}`);
    fs.writeFileSync(f, text.replace(from, to));
  };
  const scopeCtx = (scope = `feature:${qaSlug}`) => ok('view', 'scope', '--scope', scope).scope.context;
  const ledger = (...p) => path.join(qa, 'qa-ledger', ...p);
  return { ws, qa, code, cli, ok, refused, edit, scopeCtx, ledger, qaSlug };
}

function withScope(opts) {
  const w = workspace(opts);
  w.ok('init');
  w.ok('scope', 'create', '--scope', `feature:${w.qaSlug}`, '--created-by', 'dana');
  return w;
}
const resolve = (w, ...extra) => w.ok('handoff', 'resolve', '--code-repo', w.code, ...extra);
const ingest = (w, ...extra) => w.ok('handoff', 'ingest', '--scope', `feature:${w.qaSlug}`, '--code-repo', w.code, '--by', 'dana', ...extra);

// ---------- discovery ----------

test('S4-01 the handoff is found by following qa_handoff_link from the Task Breakdown', () => {
  const w = workspace();
  const r = resolve(w, '--feature', 'checkout');
  assert.equal(r.breakdown.path, BREAKDOWN);
  assert.equal(r.breakdown.encoding, 'fenced-yaml');
  assert.equal(r.handoff.path, HANDOFF, 'qa_handoff_link, not a filesystem search');
  assert.equal(r.handoff.encoding, 'delimited');
  assert.equal(r.analysis.path, ANALYSIS, 'feature_analysis_link is followed too');
  assert.deepEqual(r.resolved_by, { breakdown: 'feature-frontmatter', handoff: 'qa_handoff_link', analysis: 'feature_analysis_link' });
});

test('S4-02 the old "# QA Handoff" first-line search is gone', () => {
  const w = workspace();
  w.edit(BREAKDOWN, 'qa_handoff_link: docs/qa/checkout-qa-handoff.md', 'qa_handoff_link:');
  const r = w.refused('NEED_HANDOFF_PATH', 'handoff', 'resolve', '--code-repo', w.code, '--feature', 'checkout');
  assert.match(r.error.message, /qa_handoff_link/);
  assert.ok(fs.readFileSync(path.join(w.code, 'docs/qa/legacy-notes.md'), 'utf8').startsWith('# QA Handoff'), 'a decoy with the old first line exists and is ignored');
  const command = fs.readFileSync(path.join(PLUGIN_ROOT, 'commands', 'check-qa-coverage.md'), 'utf8');
  assert.ok(!/starts with `# QA Handoff`/.test(command), 'the command no longer searches by the first line');
  assert.ok(!/search the code repo for it automatically/.test(command));
});

test('S4-03 the human is asked for a path only when the deterministic chain cannot resolve', () => {
  const w = workspace();
  // Missing link → a human-supplied handoff path is used and checked against the breakdown.
  w.edit(BREAKDOWN, 'qa_handoff_link: docs/qa/checkout-qa-handoff.md', 'qa_handoff_link:');
  const r = resolve(w, '--feature', 'checkout', '--handoff', HANDOFF);
  assert.equal(r.resolved_by.handoff, 'explicit');
  // Two breakdowns claiming the same feature → never pick one silently.
  fs.copyFileSync(path.join(w.code, BREAKDOWN), path.join(w.code, 'docs/checkout-task-breakdown-v2.md'));
  const amb = w.refused('NEED_BREAKDOWN_PATH', 'handoff', 'resolve', '--code-repo', w.code, '--feature', 'checkout');
  assert.deepEqual(amb.error.details.candidates, ['docs/checkout-task-breakdown-v2.md', BREAKDOWN]);
  assert.equal(resolve(w, '--breakdown', BREAKDOWN, '--handoff', HANDOFF).resolved_by.breakdown, 'explicit');
  // No breakdown for the feature at all.
  const none = w.refused('NEED_BREAKDOWN_PATH', 'handoff', 'resolve', '--code-repo', w.code, '--feature', 'wallet');
  assert.deepEqual(none.error.details.candidates, []);
  const command = fs.readFileSync(path.join(PLUGIN_ROOT, 'commands', 'check-qa-coverage.md'), 'utf8');
  for (const code of ['NEED_BREAKDOWN_PATH', 'NEED_HANDOFF_PATH']) assert.ok(command.includes(code), `the command asks only on ${code}`);
});

// ---------- status gate ----------

test('S4-04 a ready-for-qa handoff is accepted', () => {
  const w = withScope();
  const r = ingest(w, '--feature', 'checkout');
  assert.equal(r.handoff_status, 'ready-for-qa');
  assert.equal(r.override, null);
  assert.equal(w.scopeCtx().dev_handoff.handoff_status, 'ready-for-qa');
});

test('S4-05 a draft handoff is refused by default and nothing is written', () => {
  const w = withScope();
  w.edit(HANDOFF, 'status: ready-for-qa # draft | ready-for-qa', 'status: draft');
  const before = fs.readFileSync(w.ledger('scopes', 'feature', 'checkout.jsonl'), 'utf8');
  const r = w.refused('HANDOFF_NOT_READY', 'handoff', 'ingest', '--scope', 'feature:checkout', '--code-repo', w.code, '--by', 'dana', '--feature', 'checkout');
  assert.equal(r.error.details.status, 'draft');
  assert.equal(fs.readFileSync(w.ledger('scopes', 'feature', 'checkout.jsonl'), 'utf8'), before);
  w.edit(HANDOFF, 'status: draft', 'status:');
  assert.equal(w.refused('HANDOFF_NOT_READY', 'handoff', 'ingest', '--scope', 'feature:checkout', '--code-repo', w.code, '--by', 'dana', '--feature', 'checkout').error.details.status, null, 'a missing status is not ready either');
});

test('S4-06 an explicit, attributed draft override is accepted and persisted', () => {
  const w = withScope();
  w.edit(HANDOFF, 'status: ready-for-qa # draft | ready-for-qa', 'status: draft');
  const base = ['handoff', 'ingest', '--scope', 'feature:checkout', '--code-repo', w.code, '--by', 'dana', '--feature', 'checkout'];
  w.refused('MISSING_ARGUMENT', ...base, '--override-by', 'lead');
  w.refused('MISSING_ARGUMENT', ...base, '--override-reason', 'Dev lead is out; QA starts early');
  const r = ingest(w, '--feature', 'checkout', '--override-by', 'lead', '--override-reason', 'Dev lead is out; QA starts early on the draft');
  assert.deepEqual([r.override.approved_by, r.override.reason, r.override.status], ['lead', 'Dev lead is out; QA starts early on the draft', 'draft']);
  assert.ok(r.override.at);
  const ctx = w.scopeCtx();
  assert.equal(ctx.handoff_overrides.length, 1);
  assert.equal(ctx.handoff_overrides[0].approved_by, 'lead');
  assert.equal(ctx.dev_handoff.handoff_status, 'draft', 'the draft is recorded as a draft, never as ready');
  assert.equal(r.coverage_frontmatter.handoff_draft_override_by, 'lead');
  assert.equal(r.coverage_frontmatter.handoff_draft_override_at, r.override.at);
  // The same draft content is not re-approved on every run; a changed draft needs a new override.
  ingest(w, '--feature', 'checkout', '--override-by', 'lead', '--override-reason', 'again');
  assert.equal(w.scopeCtx().handoff_overrides.length, 1);
  w.edit(HANDOFF, 'Cart\n- Payment', 'Cart\n- Payment\n- Receipt');
  w.refused('HANDOFF_NOT_READY', ...base);
});

// ---------- the current section contract ----------

test('S4-07 every current producer section is recognized; a missing one is a contract mismatch', () => {
  const w = withScope();
  const r = resolve(w, '--feature', 'checkout');
  assert.deepEqual(r.handoff.sections, SECTIONS);
  assert.deepEqual(r.handoff.missing_sections, []);
  assert.equal(r.handoff.contract_ok, true);
  assert.match(r.handoff.build_instructions_ref, /#build--install--testing-instructions$/);
  w.edit(HANDOFF, '## Screens & Flows Touched', '## Release Notes Draft\n\nNew.\n\n## Screens & Flows Touched');
  assert.deepEqual(resolve(w, '--feature', 'checkout').handoff.unrecognized_sections, ['Release Notes Draft'], 'an extra section is reported, not fatal');
  w.edit(HANDOFF, '## Build / Install / Testing Instructions', '## Build Notes');
  const bad = w.refused('HANDOFF_CONTRACT_MISMATCH', 'handoff', 'ingest', '--scope', 'feature:checkout', '--code-repo', w.code, '--by', 'dana', '--feature', 'checkout');
  assert.ok(bad.error.details.problems.some((p) => p.code === 'MISSING_SECTION' && p.section === 'Build / Install / Testing Instructions'));
  // The one documented contract lists the same sections the helper checks.
  const doc = fs.readFileSync(path.join(PLUGIN_ROOT, 'docs', 'dev-handoff-contract.md'), 'utf8');
  for (const s of SECTIONS) assert.ok(doc.includes(`\`${s}\``), `contract doc lists ${s}`);
});

// ---------- debt ----------

test('S4-08 Pending Verification (owed to QA) becomes QA-owned debt on the feature scope, idempotently', () => {
  const w = withScope();
  const r = ingest(w, '--feature', 'checkout');
  const debt = w.scopeCtx().debt;
  const pv = debt.filter((d) => d.rule_id);
  assert.deepEqual(pv.map((d) => [d.domain, d.rule_id, d.owner]), [
    ['accessibility', 'A11Y-SR-1', 'qa'],
    ['i18n', 'I18N-TEST-1', 'qa'],
  ]);
  assert.equal(pv[0].description, 'VoiceOver walkthrough of the Payment screen');
  assert.equal(pv[0].why_not_automatable, 'Needs a screen reader on a real device');
  assert.match(pv[0].source, /checkout-qa-handoff\.md#pending-verification-owed-to-qa$/);
  assert.match(pv[0].id, /^HV-[0-9a-f]{8}$/);
  assert.equal(r.debt_added.length, 3);
  // Re-ingesting the same handoff never duplicates debt.
  const again = ingest(w, '--feature', 'checkout');
  assert.deepEqual(again.debt_added, []);
  assert.equal(w.scopeCtx().debt.length, 3);
  // "None recorded" → no QA debt from this section.
  const n = withScope();
  n.edit(HANDOFF, /\| domain[\s\S]*$/.exec(fs.readFileSync(path.join(n.code, HANDOFF), 'utf8'))[0], 'None recorded\n');
  ingest(n, '--feature', 'checkout');
  assert.deepEqual(n.scopeCtx().debt.filter((d) => d.rule_id), []);
});

test('S4-09 developer-owned debt and Known Limitations stay developer-owned', () => {
  const w = withScope();
  const r = ingest(w, '--feature', 'checkout');
  assert.match(r.developer_context.known_limitations, /VERIFY-4/);
  assert.ok(!w.scopeCtx().debt.some((d) => /unit test|VERIFY-4|Apple Pay/.test(JSON.stringify(d))), 'no Known Limitation became QA debt');
  // A developer-owned row misfiled under Pending Verification is shown, never ingested as QA debt.
  const m = withScope();
  m.edit(HANDOFF, '| i18n | I18N-TEST-1 |', '| developer-testing | VERIFY-4 | Payment retry unit test | CI runner lacks the SDK | developer |\n| i18n | I18N-TEST-1 |');
  const mr = ingest(m, '--feature', 'checkout');
  assert.deepEqual(mr.developer_context.misfiled_developer_debt.map((d) => d.rule_id), ['VERIFY-4']);
  assert.ok(!m.scopeCtx().debt.some((d) => d.rule_id === 'VERIFY-4'));
  // A row with no recognizable owner is a contract problem — never guessed.
  const b = withScope();
  b.edit(HANDOFF, '| qa |\n| i18n', '| someone |\n| i18n');
  b.refused('HANDOFF_CONTRACT_MISMATCH', 'handoff', 'ingest', '--scope', 'feature:checkout', '--code-repo', b.code, '--by', 'dana', '--feature', 'checkout');
});

test('S4-10 accessibility notRecorded needs QA attention — never read as covered', () => {
  const w = withScope();
  const r = ingest(w, '--feature', 'checkout');
  assert.deepEqual(r.accessibility, { statuses: ['applicable', 'notRecorded'], attention: true });
  const item = w.scopeCtx().debt.find((d) => d.id === 'HV-a11y-not-recorded');
  assert.equal(item.owner, 'qa');
  assert.equal(item.domain, 'accessibility');
  assert.equal(r.coverage_frontmatter.accessibility_status, 'applicable, notRecorded');
  // All applicable → no attention item.
  const ok = withScope();
  ok.edit(HANDOFF, 'T2: notRecorded — the task predates the accessibility contract.', 'T2: notApplicable — "a build script, no surface assistive technology perceives"');
  const r2 = ingest(ok, '--feature', 'checkout');
  assert.deepEqual(r2.accessibility, { statuses: ['applicable', 'notApplicable'], attention: false });
  assert.ok(!ok.scopeCtx().debt.some((d) => d.id === 'HV-a11y-not-recorded'));
  // No recognizable status at all is not a pass either.
  const none = withScope();
  none.edit(HANDOFF, /## Accessibility Check\n\n[\s\S]*?\n\n## Pending/.exec(fs.readFileSync(path.join(none.code, HANDOFF), 'utf8'))[0], '## Accessibility Check\n\nLooks fine.\n\n## Pending');
  assert.equal(ingest(none, '--feature', 'checkout').accessibility.attention, true);
});

// ---------- identity ----------

test('S4-11 the canonical Dev feature identity is bound to the QA scope without renaming either', () => {
  const w = withScope({ qaSlug: 'checkout-redesign' });
  ingest(w, '--breakdown', BREAKDOWN);
  const ctx = w.scopeCtx();
  assert.equal(ctx.dev_handoff.feature, 'checkout', 'the Dev identity is kept verbatim');
  assert.ok(w.ok('view', 'scope', '--scope', 'feature:checkout-redesign').scope, 'the QA scope keeps its own slug');
  assert.deepEqual(ctx.plans, ['checkout-redesign/test-plan.md'], 'the existing QA plan is bound to the scope');
  // A scope bound to one Dev feature never silently rebinds to another.
  w.edit(BREAKDOWN, 'feature: checkout', 'feature: wallet');
  w.edit(HANDOFF, 'feature: checkout', 'feature: wallet');
  w.refused('IDENTITY_CONFLICT', 'handoff', 'ingest', '--scope', 'feature:checkout-redesign', '--code-repo', w.code, '--by', 'dana', '--breakdown', BREAKDOWN);
});

test('S4-12 Task Breakdown, handoff and Feature Analysis links are persisted', () => {
  const w = withScope();
  ingest(w, '--feature', 'checkout');
  const h = w.scopeCtx().dev_handoff;
  assert.equal(h.task_breakdown_link, BREAKDOWN);
  assert.equal(h.qa_handoff_link, HANDOFF);
  assert.equal(h.feature_analysis_link, ANALYSIS);
  assert.equal(h.dd_link, 'docs/checkout-DD.md');
  assert.equal(h.build_instructions_ref, `${HANDOFF}#build--install--testing-instructions`);
  assert.match(h.handoff_fingerprint, /^sha256:/);
  // Next time the recorded breakdown link resolves the chain with no feature name at all.
  assert.equal(resolve(w, '--scope', 'feature:checkout').resolved_by.breakdown, 'scope');
});

test('S4-13 platform, device_type, surface and capability are carried when available', () => {
  const w = withScope();
  ingest(w, '--feature', 'checkout');
  const ctx = w.scopeCtx();
  assert.deepEqual([ctx.dev_handoff.platform, ctx.dev_handoff.device_type, ctx.dev_handoff.surface, ctx.dev_handoff.capability], ['react-native', 'mobile', 'mobile-app', 'checkout-payments']);
  assert.equal(ctx.capability, 'checkout-payments', 'the capability reference joins the scope for later stages');
  assert.equal(ctx.surfaces, undefined, 'QA-required surfaces stay QA-entered (/set-qa-scope)');
  // An older analysis without surface/capability → null, never guessed.
  const old = withScope();
  old.edit(ANALYSIS, 'surface: mobile-app\ncapability: checkout-payments\n', '');
  ingest(old, '--feature', 'checkout');
  const oc = old.scopeCtx();
  assert.deepEqual([oc.dev_handoff.surface, oc.dev_handoff.capability, oc.capability], [null, null, undefined]);
  // Identity mismatches between Dev artifacts are refused.
  const bad = withScope();
  bad.edit(HANDOFF, 'platform: react-native', 'platform: ios');
  bad.refused('IDENTITY_MISMATCH', 'handoff', 'ingest', '--scope', 'feature:checkout', '--code-repo', bad.code, '--by', 'dana', '--feature', 'checkout');
});

// ---------- preservation ----------

test('S4-14 the existing QA test plan stays byte-identical', () => {
  const w = withScope();
  const plan = path.join(w.qa, 'checkout', 'test-plan.md');
  const before = fs.readFileSync(plan);
  ingest(w, '--feature', 'checkout');
  ingest(w, '--feature', 'checkout');
  assert.deepEqual(fs.readFileSync(plan), before);
});

test('S4-15 the coverage methodology is unchanged — only its input contract moved to one reference', () => {
  const skill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'qa-coverage-analysis', 'SKILL.md'), 'utf8');
  const agent = fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', 'qa-coverage-reviewer.md'), 'utf8');
  for (const text of [skill, agent]) {
    for (const needle of ['Covered', 'Partially Covered', 'Gap', 'docs/dev-handoff-contract.md']) assert.ok(text.includes(needle), needle);
    assert.match(text, /possibly.stale/i);
    assert.ok(!text.includes('i18n/RTL Check, Accessibility Check'), 'the stale hard-coded 8-section list is gone');
  }
  assert.match(skill, /by substance \(a paraphrase counts as a match\)/);
  assert.match(agent, /match on meaning, not exact wording/);
  const template = fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'qa-coverage-report-template.md'), 'utf8');
  assert.deepEqual(template.match(/^## .+$/gm), ['## Comparison Scope', '## Coverage Matrix', '## Gaps (Dev-Documented, Not Covered by QA)', '## Possibly-Stale QA Test Cases', '## Summary & Recommendation']);
  assert.ok(template.startsWith('---\n'), 'machine-readable delimited frontmatter');
  for (const key of ['dev_feature:', 'qa_scope:', 'task_breakdown_link:', 'qa_handoff_link:', 'feature_analysis_link:', 'handoff_status:', 'handoff_draft_override_by:', 'platform:', 'device_type:', 'surface:', 'capability:', 'coverage_covered:', 'coverage_partial:', 'coverage_gap:']) assert.ok(template.includes(key), key);
  assert.ok(!/readiness|READY/.test(template));
});

test('S4-16 Stage 1–3 ledger flows keep working on a handoff-bound scope', () => {
  const w = withScope();
  ingest(w, '--feature', 'checkout');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'surfaces', '--value', '["android"]', '--by', 'dana');
  w.ok('scope', 'event', '--scope', 'feature:checkout', '--op', 'set', '--field', 'devices', '--value', '[{"surface":"android","device":"Pixel 8"}]', '--by', 'dana');
  w.ok('build', 'add', '--id', '103', '--surfaces', 'android', '--registered-by', 'dana', '--related-scope', 'feature:checkout');
  w.refused('SMOKE_GATE_CLOSED', 'run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'checkout/test-plan.md');
  const smoke = w.ok('run', 'open', '--type', 'smoke', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'smoke/android/smoke-suite.md').run_id;
  for (const c of ['smoke/android/S1', 'smoke/android/S2']) w.ok('result', 'add', '--run', smoke, '--case', c, '--result', 'pass');
  w.ok('run', 'close', '--run', smoke);
  const run = w.ok('run', 'open', '--type', 'functional', '--scope', 'feature:checkout', '--build', '103', '--surface', 'android', '--device', 'Pixel 8', '--executor', 'dana', '--plan', 'checkout/test-plan.md').run_id;
  w.ok('result', 'add', '--run', run, '--case', 'checkout/TC14', '--result', 'fail');
  w.ok('run', 'close', '--run', run);
  w.ok('bug', 'report', '--id', 'BUG-1', '--from-run', run, '--case', 'checkout/TC14', '--title', 'Spinner', '--severity', 'major', '--actual', 'Spins', '--by', 'dana');
  assert.equal(w.ok('view', 'bug', '--bug', 'bug:BUG-1').bug.state, 'assigned');
  assert.equal(w.ok('validate').errors.length, 0);
});

function sources() {
  // Since Stage 5, lib/qa-ledger/knowledge.mjs is the one designated Project Knowledge consumer; no other module may touch it.
  const files = [path.join(HERE, 'qa-ledger.mjs'), ...fs.readdirSync(path.join(HERE, 'lib', 'qa-ledger')).filter((f) => f !== 'knowledge.mjs').map((f) => path.join(HERE, 'lib', 'qa-ledger', f))];
  return files.map((f) => [path.relative(PLUGIN_ROOT, f), fs.readFileSync(f, 'utf8')]);
}

test('S4-17 no Project Knowledge reader is added', () => {
  const w = withScope();
  fs.mkdirSync(path.join(w.code, '.ono'));
  fs.writeFileSync(path.join(w.code, '.ono', 'repo-knowledge.json'), '{"capabilities":[{"id":"something-else"}]}');
  ingest(w, '--feature', 'checkout');
  assert.equal(w.scopeCtx().capability, 'checkout-payments', 'capability comes from the Dev feature analysis, never from the manifest');
  for (const [file, text] of sources()) for (const needle of ['repo-knowledge', 'docs/project', 'capabilityRelationships']) assert.ok(!text.includes(needle), `${file}: ${needle}`);
});

// Regression arrived in Stage 5; readiness and sign-off are still absent.
test('S4-18 no regression logic and S4-19 no readiness logic are added', () => {
  const w = withScope();
  for (const cmd of [['readiness'], ['signoff'], ['view', 'readiness']]) w.refused('UNKNOWN_COMMAND', ...cmd, '--scope', 'feature:checkout');
  for (const name of fs.readdirSync(path.join(PLUGIN_ROOT, 'commands'))) assert.ok(!/readiness|sign-?off|release/i.test(name), name);
  const out = JSON.stringify(ingest(w, '--feature', 'checkout'));
  assert.ok(!/READY_WITH|verdict|NOT_READY/.test(out));
});

test('S4-20 Dev artifacts are read-only: nothing in the code repo is ever written', () => {
  const w = withScope();
  const before = snapshot(w.code);
  resolve(w, '--feature', 'checkout');
  ingest(w, '--feature', 'checkout');
  w.edit(HANDOFF, 'status: ready-for-qa # draft | ready-for-qa', 'status: draft');
  const devBefore = snapshot(w.code);
  ingest(w, '--feature', 'checkout', '--override-by', 'lead', '--override-reason', 'early start');
  assert.deepEqual(snapshot(w.code), devBefore);
  assert.notDeepEqual(before, devBefore, 'only the test itself edited the handoff');
  // The code repo is never the QA repo, and links never escape it.
  w.refused('CODE_REPO_IS_QA_REPO', 'handoff', 'resolve', '--code-repo', w.qa, '--feature', 'checkout');
  w.edit(BREAKDOWN, 'qa_handoff_link: docs/qa/checkout-qa-handoff.md', 'qa_handoff_link: ../acme-qa/checkout/test-plan.md');
  w.refused('PATH_OUTSIDE_CODE_REPO', 'handoff', 'resolve', '--code-repo', w.code, '--feature', 'checkout');
  for (const [file, text] of sources()) if (file.endsWith('handoff.mjs')) assert.ok(!/writeFileSync|appendFileSync|mkdirSync|renameSync|rmSync/.test(text), 'the handoff reader never writes');
});

test('S4-21 the coverage frontmatter carries the whole identity for the report', () => {
  const w = withScope();
  const fm = ingest(w, '--feature', 'checkout').coverage_frontmatter;
  assert.deepEqual(fm, {
    feature: 'checkout',
    qa_scope: 'feature:checkout',
    qa_feature_path: 'checkout/',
    dev_feature: 'checkout',
    task_breakdown_link: BREAKDOWN,
    qa_handoff_link: HANDOFF,
    dev_handoff_source: HANDOFF,
    feature_analysis_link: ANALYSIS,
    handoff_status: 'ready-for-qa',
    handoff_fingerprint: w.scopeCtx().dev_handoff.handoff_fingerprint,
    handoff_draft_override_by: null,
    handoff_draft_override_reason: null,
    handoff_draft_override_at: null,
    platform: 'react-native',
    device_type: 'mobile',
    surface: 'mobile-app',
    capability: 'checkout-payments',
    accessibility_status: 'applicable, notRecorded',
    qa_debt_ids: w.scopeCtx().debt.map((d) => d.id),
    test_plan_source: 'checkout/test-plan.md',
  });
});
