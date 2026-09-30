// Mutation tests for the ledger's critical invariants.
//
// Each mutant is a copy of scripts/qa-ledger.mjs with one guard disabled. The
// tests in qa-ledger.test.mjs that cover that invariant are re-run against the
// mutant (via QA_LEDGER_HELPER) and must FAIL — a mutant that survives means the
// invariant is not actually tested. An unmutated copy is run first as a control,
// so a broken harness cannot make every mutant look "killed".
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
const SOURCE = fs.readFileSync(path.join(HERE, 'qa-ledger.mjs'), 'utf8');
const SUITE = path.join(HERE, 'qa-ledger.test.mjs');

// [invariant, exact source text, replacement, tests (by number) that must catch it]
const MUTANTS = [
  ['duplicate build ids are refused', "if (findCaseInsensitive(store.list('builds'), `${id}.json`)) fail('DUPLICATE_BUILD'", 'if (false) fail(\'DUPLICATE_BUILD\'', ['04']],
  ['terminal runs are immutable', "if (run.state !== 'open') fail('RUN_NOT_OPEN'", "if (false) fail('RUN_NOT_OPEN'", ['10']],
  ['record hashes are verified', "return typeof hash === 'string' && hash === sha(canonical(rest));", 'return true;', ['15']],
  ['the prev-hash chain is verified', 'if (rec.seq !== records.length || rec.prev !== (records.length ? prev : null)) {', 'if (false) {', ['15']],
  ['nothing is recorded after a terminal event', "if (state !== 'open') {\n      errors.push({ code: 'EVENT_AFTER_TERMINAL'", "if (false) {\n      errors.push({ code: 'EVENT_AFTER_TERMINAL'", ['15']],
  ['a correction supersedes the same case only', "if (prior.case_key !== o.case) fail('SUPERSEDE_CASE_MISMATCH'", "if (false) fail('SUPERSEDE_CASE_MISMATCH'", ['12']],
  ['a run references a registered build', "if (!build) fail('UNKNOWN_BUILD'", "if (false) fail('UNKNOWN_BUILD'", ['05']],
  ['retest/reproduction runs reference a bug', "if (BUG_REF_TYPES.includes(o.type) && !bugRef) fail('BUG_REF_REQUIRED'", "if (false) fail('BUG_REF_REQUIRED'", ['05']],
  ['writes only append', 'fs.appendFileSync(this.p(...segments), line);', 'fs.writeFileSync(this.p(...segments), line);', ['08', '09']],
  ['ledger paths never follow symlinks', "if (st.isSymbolicLink()) fail('SYMLINK_REFUSED'", "if (false) fail('SYMLINK_REFUSED'", ['16']],
  [
    'plan reads stay inside the QA repo',
    "if (path.isAbsolute(rel) || !abs.startsWith(root + path.sep)) fail('PATH_OUTSIDE_QA_REPO'",
    "if (false) fail('PATH_OUTSIDE_QA_REPO'",
    ['16'],
    ["if (!real.startsWith(root + path.sep)) fail('PATH_OUTSIDE_QA_REPO'", "if (false) fail('PATH_OUTSIDE_QA_REPO'"],
  ],
  ['results must resolve to a real test case', "if (!row) fail('UNKNOWN_CASE'", "if (false) fail('UNKNOWN_CASE'", ['11']],
  ['latest-result ignores open runs', "h.run_state === 'closed' && h.superseded_by === null", 'h.superseded_by === null', ['18']],
  // Not listed: dropping `h.superseded_by === null` from latest-result is an equivalent
  // mutant — a correction always follows the result it supersedes inside the same run,
  // so the last result in history order is never a superseded one.
  ['aborted runs never count as the latest result', "h.run_state === 'closed' && h.superseded_by === null", "h.run_state !== 'open' && h.superseded_by === null", ['20']],
];

function runSuite(helperSource, tests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ledger-mutant-'));
  const helper = path.join(dir, 'qa-ledger.mjs');
  fs.writeFileSync(helper, helperSource);
  const pattern = `^(${tests.join('|')}) `;
  // NODE_TEST_CONTEXT must not leak in, or the child reports to this runner instead of stdout.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, SUITE], {
    encoding: 'utf8',
    env: { ...env, QA_LEDGER_HELPER: helper },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const ran = Number(/^# tests (\d+)$/m.exec(r.stdout)?.[1] ?? 0);
  return { status: r.status, ran, output: r.stdout + r.stderr };
}

test('control: the unmutated helper passes every targeted test', () => {
  const all = [...new Set(MUTANTS.flatMap((m) => m[3]))];
  const r = runSuite(SOURCE, all);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.ran, all.length, 'every targeted test was selected');
});

for (const [invariant, target, replacement, tests, extra] of MUTANTS) {
  test(`mutant killed: ${invariant}`, () => {
    assert.ok(SOURCE.includes(target), `mutation target not found — update this harness: ${target}`);
    let mutated = SOURCE.replace(target, replacement);
    if (extra) {
      assert.ok(SOURCE.includes(extra[0]), `mutation target not found: ${extra[0]}`);
      mutated = mutated.replace(extra[0], extra[1]);
    }
    const r = runSuite(mutated, tests);
    assert.ok(r.ran > 0, 'the targeted tests ran');
    assert.notEqual(r.status, 0, `the mutant survived — tests ${tests.join(', ')} do not guard "${invariant}"\n${r.output.slice(-2000)}`);
  });
}
