// Mutation tests for the ledger's critical invariants.
//
// Each mutant is a copy of the helper (scripts/qa-ledger.mjs plus its internal
// modules under scripts/lib/qa-ledger/) with one guard disabled. The tests that
// cover that invariant are re-run against the mutant (via QA_LEDGER_HELPER) and
// must FAIL — a mutant that survives means the invariant is not actually tested.
// An unmutated copy is run first as a control, so a broken harness cannot make
// every mutant look "killed".
//
// Run: node --test scripts/qa-ledger.mutation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join('lib', 'qa-ledger');
const SOURCES = ['qa-ledger.mjs', ...fs.readdirSync(path.join(HERE, LIB)).map((f) => path.join(LIB, f))];
const SUITES = { s1: path.join(HERE, 'qa-ledger.test.mjs'), s2: path.join(HERE, 'qa-execution.test.mjs'), s3: path.join(HERE, 'qa-bugs.test.mjs'), s4: path.join(HERE, 'qa-handoff.test.mjs') };

// [invariant, exact source text, replacement, tests that must catch it ({ suite: [test-name prefixes] })]
const MUTANTS = [
  // ---- Stage 1: structure and append-only history ----
  ['duplicate build ids are refused', "if (findCaseInsensitive(store.list('builds'), `${id}.json`)) fail('DUPLICATE_BUILD'", "if (false) fail('DUPLICATE_BUILD'", { s1: ['04'], s2: ['S2-01'] }],
  ['terminal runs are immutable', "if (run.state !== 'open') fail('RUN_NOT_OPEN'", "if (false) fail('RUN_NOT_OPEN'", { s1: ['10'] }],
  ['record hashes are verified', "return typeof hash === 'string' && hash === sha(canonical(rest));", 'return true;', { s1: ['15'] }],
  ['the prev-hash chain is verified', 'if (rec.seq !== records.length || rec.prev !== (records.length ? prev : null)) {', 'if (false) {', { s1: ['15'] }],
  ['nothing is recorded after a terminal event', "if (state !== 'open') {\n      errors.push({ code: 'EVENT_AFTER_TERMINAL'", "if (false) {\n      errors.push({ code: 'EVENT_AFTER_TERMINAL'", { s1: ['15'] }],
  ['a correction supersedes the same case only', "if (prior.case_key !== o.case) fail('SUPERSEDE_CASE_MISMATCH'", "if (false) fail('SUPERSEDE_CASE_MISMATCH'", { s1: ['12'] }],
  ['a run references a registered build', "if (!build) fail('UNKNOWN_BUILD', `build ${o.build} is not registered`); // invariant:run-build-exists", "if (false) fail('UNKNOWN_BUILD', ''); // invariant:run-build-exists", { s1: ['05'] }],
  ['retest/reproduction runs reference a bug', "if (BUG_REF_TYPES.includes(o.type) && !bugRef) fail('BUG_REF_REQUIRED'", "if (false) fail('BUG_REF_REQUIRED'", { s1: ['05'] }],
  ['writes only append', 'fs.appendFileSync(this.p(...segments), line);', 'fs.writeFileSync(this.p(...segments), line);', { s1: ['08', '09'], s2: ['S2-13'], s3: ['S3-28'] }],
  ['ledger paths never follow symlinks', "if (st.isSymbolicLink()) fail('SYMLINK_REFUSED'", "if (false) fail('SYMLINK_REFUSED'", { s1: ['16'] }],
  [
    'plan reads stay inside the QA repo',
    "if (path.isAbsolute(rel) || !abs.startsWith(root + path.sep)) fail('PATH_OUTSIDE_QA_REPO'",
    "if (false) fail('PATH_OUTSIDE_QA_REPO'",
    { s1: ['16'] },
    ["if (!real.startsWith(root + path.sep)) fail('PATH_OUTSIDE_QA_REPO'", "if (false) fail('PATH_OUTSIDE_QA_REPO'"],
  ],
  ['results must resolve to a real test case', "if (!row) fail('UNKNOWN_CASE'", "if (false) fail('UNKNOWN_CASE'", { s1: ['11'] }],
  ['latest-result ignores open runs', "h.run_state === 'closed' && h.superseded_by === null", 'h.superseded_by === null', { s1: ['18'] }],
  // Not listed: dropping `h.superseded_by === null` from latest-result is an equivalent
  // mutant — a correction always follows the result it supersedes inside the same run,
  // so the last result in history order is never a superseded one.
  ['aborted runs never count as the latest result', "h.run_state === 'closed' && h.superseded_by === null", "h.run_state !== 'open' && h.superseded_by === null", { s1: ['20'] }],

  // ---- Stage 2: smoke gate and functional execution ----
  ['functional runs wait for the smoke gate', 'if (!gate.open) {', 'if (false) {', { s2: ['S2-06', 'S2-07', 'S2-08', 'S2-10', 'S2-16'], s3: ['S3-29', 'S3-31'] }],
  ['a smoke FAIL rejects the build', "if (counts.fail) return 'failed';", '', { s2: ['S2-07'] }],
  ['a smoke BLOCKED rejects the build', "if (counts.blocked) return 'blocked';", '', { s2: ['S2-08'] }],
  ['a smoke with NOT_RUN cases is not a pass', "if (counts.not_run) return 'incomplete';", '', { s2: ['S2-08'] }],
  ['smoke runs once per build and surface', "if (smoke.run_id) fail('SMOKE_ALREADY_RECORDED'", "if (false) fail('SMOKE_ALREADY_RECORDED'", { s2: ['S2-07', 'S2-10'] }],
  ['only one smoke run may be open per build and surface', "if (smoke.status === 'in_progress') fail('SMOKE_IN_PROGRESS'", "if (false) fail('SMOKE_IN_PROGRESS'", { s2: ['S2-06'] }],
  ['a smoke run is closed only when every case has a result', "if (missing.length) fail('SMOKE_INCOMPLETE'", "if (false) fail('SMOKE_INCOMPLETE'", { s2: ['S2-06'] }],
  ['smoke executes the suite of its own surface', "if (planRefs.length !== 1 || planRefs[0].plan !== smokeSuitePath(surface)) fail('INVALID_SMOKE_SUITE'", "if (false) fail('INVALID_SMOKE_SUITE'", { s2: ['S2-05'] }],
  ['an override needs a reason', "idOk(v.build_id) && idOk(v.surface) && isStr(v.reason)", 'idOk(v.build_id) && idOk(v.surface)', { s2: ['S2-09'] }],
  ['an override opens the gate only for its own scope', "const scope = model.scopes.get(scopeRef);\n  const override", "const scope = [...model.scopes.values()].find((s) => activeOverrides(s).has(`${buildId}@${surface}`)) ?? model.scopes.get(scopeRef);\n  const override", { s2: ['S2-09'] }],
  ['a retracted override closes the gate', "else if (e.kind === 'context.retract') active.delete(e.value);", '', { s2: ['S2-09'] }],
  ['functional runs need an approved plan', "if (status !== 'approved') fail('PLAN_NOT_APPROVED'", "if (false) fail('PLAN_NOT_APPROVED'", { s2: ['S2-21'] }],
  ['functional runs need a declared device', "if (!matching.length) fail('DEVICE_NOT_IN_SCOPE'", "if (false) fail('DEVICE_NOT_IN_SCOPE'", { s2: ['S2-04'] }],
  ['excluded cases cannot be recorded', "if (excluded) fail('CASE_EXCLUDED'", "if (false) fail('CASE_EXCLUDED'", { s2: ['S2-22'] }],
  ['a changed plan row makes evidence stale', "if (latest.case_ref.row_hash !== row.row_hash) return 'stale';", '', { s2: ['S2-14'] }],
  ['validate re-derives the gate for every functional run', "if (!gateFor(model, h.scope, h.build_id, h.surface, h.at).open) errors.push", 'if (false) errors.push', { s2: ['S2-24'] }],
  ['validate refuses a second closed smoke run', "if (closedSmoke.has(key)) errors.push", 'if (false) errors.push', { s2: ['S2-24'] }],
  // ---- Stage 3: bug state transitions and close/reopen guards ----
  ['a bug can only be reported from a FAIL', "if (result.result !== 'fail') fail('NOT_A_FAILURE'", "if (false) fail('NOT_A_FAILURE'", { s3: ['S3-03'] }],
  ['reproduction is only for a bug not yet reproduced', "if (!AWAITING_VERIFICATION.includes(bug.state)) fail('BUG_NOT_AWAITING_VERIFICATION'", "if (false) fail('BUG_NOT_AWAITING_VERIFICATION'", { s3: ['S3-07', 'S3-27'] }],
  ['a fix claim needs a reproduced bug', "if (AWAITING_VERIFICATION.includes(bug.state)) fail('BUG_NOT_REPRODUCED', `${bug.bug} is ${bug.state} — QA must reproduce", "if (false) fail('BUG_NOT_REPRODUCED', `${bug.bug} is ${bug.state} — QA must reproduce", { s3: ['S3-10'] }],
  ['a closed bug takes no fix claim', "if (CLOSED.includes(bug.state)) fail('BUG_CLOSED', `${bug.bug} is ${bug.state} — a closed bug takes no fix claim`);", '', { s3: ['S3-08'] }],
  ['a fix claim never closes a bug', "      state = 'fix_delivered';", "      state = 'closed_verified';", { s3: ['S3-11'] }],
  ['a re-test waits for a fix after a reopen', "if (DEV_OWNED.includes(bug.state)) fail('BUG_AWAITING_FIX'", "if (false) fail('BUG_AWAITING_FIX'", { s3: ['S3-14', 'S3-15', 'S3-20'] }],
  ['a re-test never runs on a build older than the fix', "if (idx.get(buildId) < idx.get(bug.current_fix_build)) fail('RETEST_BUILD_BEFORE_FIX'", "if (false) fail('RETEST_BUILD_BEFORE_FIX'", { s3: ['S3-15'] }],
  ['a re-test FAIL reopens the bug', "          state = 'reopened';", '', { s3: ['S3-13', 'S3-14'] }],
  ['a reopen ends the failed fix cycle', "cycle.claim.outcome = 'failed';\n          cycle = null;", "cycle.claim.outcome = 'failed';", { s3: ['S3-14'] }],
  ['a re-test PASS closes only when every affected surface passed', 'if (surfaces.every((s) => cycle.passed.has(s))) {', 'if (true) {', { s3: ['S3-12'] }],
  ['a BLOCKED re-test never counts as a pass', "if (results.includes('blocked') || results.includes('not_run')) return 'blocked';", '', { s3: ['S3-12'] }],
  ['a bug run needs its scenario outcome to close', "if (runOutcome(run, h.bug_ref) === null) fail('BUG_OUTCOME_REQUIRED'", "if (false) fail('BUG_OUTCOME_REQUIRED'", { s3: ['S3-27'] }],
  ['verified is never a manual resolution', 'if (!RESOLUTIONS.includes(rec.resolution)) return bad(', 'if (false) return bad(', { s3: ['S3-20'] }],
  ['a closed bug cannot be resolved again', "if (CLOSED.includes(bug.state)) fail('BUG_CLOSED', `${bug.bug} is ${bug.state}`); // invariant:resolve-open-only", '// resolve guard removed', { s3: ['S3-21'] }],
  ['bug re-tests wait for the smoke gate of their exact build', "if (o.type === 'retest') requireSmokeGate(", "if (false) requireSmokeGate(", { s3: ['S3-29', 'S3-30', 'S3-31', 'S3-32', 'S3-35', 'S3-38'] }],
  ['validate re-derives the smoke gate for every re-test', "if (h.execution_type === 'retest' && !gateFor(", "if (false && !gateFor(", { s3: ['S3-37'] }],
  ['a later fix claim becomes the fix under test', 'cycle = { claim, idx: idx.get(claim.build_id), passed: new Set() };', 'cycle ??= { claim, idx: idx.get(claim.build_id), passed: new Set() };', { s3: ['S3-38'] }],
  ['a superseded fix build cannot be re-tested', "if (superseded) fail('FIX_CLAIM_SUPERSEDED'", "if (false) fail('FIX_CLAIM_SUPERSEDED'", { s3: ['S3-38'] }],
  ['a smoke run records only its own suite cases', "if (h.execution_type === 'smoke' && !caseKey.startsWith(", "if (false && !caseKey.startsWith(", { s3: ['S3-39'] }],
  ['smoke run-cases never offer the bug scenario', "h.execution_type === 'smoke' ? [] : ", '', { s3: ['S3-39', 'S3-17'] }],
  // ---- Stage 4: Dev → QA handoff integration ----
  ['a handoff that is not ready-for-qa is refused', 'if (r.handoff.status !== READY_STATUS) { // invariant:handoff-status-gate', 'if (false) { // invariant:handoff-status-gate', { s4: ['S4-05', 'S4-06'] }],
  ['a draft approval covers only the exact handoff content', 'e.value.handoff_fingerprint === fingerprint', 'true', { s4: ['S4-06'] }],
  ['only rows owned by qa become QA debt', "const qaRows = pv.rows.filter((r) => r.owner === 'qa'); // invariant:qa-owned-only", 'const qaRows = pv.rows; // invariant:qa-owned-only', { s4: ['S4-09'] }],
  ['accessibility notRecorded always needs attention', "attention: statuses.includes('notRecorded') || statuses.length === 0", 'attention: false', { s4: ['S4-10'] }],
  ['the handoff is found through qa_handoff_link', 'else if (b.qa_handoff_link) {', 'else if (false) {', { s4: ['S4-01', 'S4-04'] }],
  ['several candidate breakdowns are never resolved silently', "if (candidates.length !== 1) fail('NEED_BREAKDOWN_PATH'", "if (candidates.length === 0) fail('NEED_BREAKDOWN_PATH'", { s4: ['S4-03'] }],
  ['the recorded breakdown link resolves the chain next time', 'else if (recorded?.task_breakdown_link) {', 'else if (false) {', { s4: ['S4-12'] }],
  ['a handoff that breaks the section contract is refused', "if (!r.handoff.contract_ok) fail('HANDOFF_CONTRACT_MISMATCH'", "if (false) fail('HANDOFF_CONTRACT_MISMATCH'", { s4: ['S4-07', 'S4-09'] }],
  ['a scope is never silently rebound to another Dev feature', "if (recorded && recorded.feature !== r.identity.feature) fail('IDENTITY_CONFLICT'", "if (false) fail('IDENTITY_CONFLICT'", { s4: ['S4-11'] }],
  [
    'Dev artifact links never escape the code repo',
    "if (path.isAbsolute(rel) || !abs.startsWith(root + path.sep)) fail('PATH_OUTSIDE_CODE_REPO'",
    "if (false) fail('PATH_OUTSIDE_CODE_REPO'",
    { s4: ['S4-20'] },
    ["if (!fs.realpathSync(abs).startsWith(root + path.sep)) fail('PATH_OUTSIDE_CODE_REPO'", "if (false) fail('PATH_OUTSIDE_CODE_REPO'"],
  ],
  ['validate replays every bug transition', 'errors.push(...deriveBug(model, scope.ref).violations);', '', { s3: ['S3-26'] }],
  ['execution views count only closed functional runs', "r.header.execution_type === 'functional' && r.state === 'closed'", "r.header.execution_type === 'functional'", { s2: ['S2-11', 'S2-14'] }],
];

function copyHelper(dir, mutate = (src) => src) {
  for (const rel of SOURCES) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), mutate(rel, fs.readFileSync(path.join(HERE, rel), 'utf8')));
  }
  return path.join(dir, 'qa-ledger.mjs');
}

function runSuites(mutate, tests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ledger-mutant-'));
  const helper = copyHelper(dir, mutate);
  // NODE_TEST_CONTEXT must not leak in, or the child reports to this runner instead of stdout.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const outcomes = [];
  for (const [suite, names] of Object.entries(tests)) {
    const pattern = `^(${names.join('|')}) `;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, SUITES[suite]], { encoding: 'utf8', env: { ...env, QA_LEDGER_HELPER: helper } });
    outcomes.push({ suite, status: r.status, ran: Number(/^# tests (\d+)$/m.exec(r.stdout)?.[1] ?? 0), output: r.stdout + r.stderr });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return outcomes;
}

function locate(target) {
  const hits = SOURCES.filter((rel) => fs.readFileSync(path.join(HERE, rel), 'utf8').includes(target));
  assert.equal(hits.length, 1, `mutation target must occur in exactly one source file (found ${hits.length}) — update this harness: ${target}`);
  return hits[0];
}

test('control: the unmutated helper passes every targeted test', () => {
  const tests = {};
  for (const m of MUTANTS) for (const [suite, names] of Object.entries(m[3])) tests[suite] = [...new Set([...(tests[suite] ?? []), ...names])];
  for (const o of runSuites((rel, src) => src, tests)) {
    assert.equal(o.status, 0, o.output);
    assert.equal(o.ran, tests[o.suite].length, `every targeted ${o.suite} test was selected`);
  }
});

for (const [invariant, target, replacement, tests, extra] of MUTANTS) {
  test(`mutant killed: ${invariant}`, () => {
    const file = locate(target);
    const extraFile = extra ? locate(extra[0]) : null;
    const outcomes = runSuites((rel, src) => {
      let out = rel === file ? src.replace(target, replacement) : src;
      if (extra && rel === extraFile) out = out.replace(extra[0], extra[1]);
      return out;
    }, tests);
    assert.ok(outcomes.every((o) => o.ran > 0), 'the targeted tests ran');
    assert.ok(outcomes.some((o) => o.status !== 0), `the mutant survived — ${JSON.stringify(tests)} do not guard "${invariant}"\n${outcomes.map((o) => o.output.slice(-1500)).join('\n')}`);
  });
}
