// The filesystem boundary of the QA ledger — the only module that writes to disk.
// Internal module of scripts/qa-ledger.mjs, which is the only place a Store is
// constructed; every other module receives a loaded model or the QA repo root.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { LEDGER_DIR, fail } from './core.mjs';

export function resolveQaRepo(arg) {
  if (!arg) fail('MISSING_ARGUMENT', '--qa-repo <path> is required');
  let root;
  try {
    root = fs.realpathSync(path.resolve(arg));
  } catch {
    fail('NOT_A_QA_REPO', `${arg} does not exist`);
  }
  if (!fs.statSync(root).isDirectory()) fail('NOT_A_QA_REPO', `${root} is not a directory`);
  if (!fs.existsSync(path.join(root, '.git'))) fail('NOT_A_QA_REPO', `${root} is not a git repository root`);
  if (fs.existsSync(path.join(root, '.ono'))) {
    fail('NOT_A_QA_REPO', `${root} has .ono/ (Project Knowledge) — that is an application repo, never the QA repo`);
  }
  const manifest = path.join(root, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(manifest)) {
    let name = null;
    try {
      name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name;
    } catch {
      /* not a plugin manifest we recognize */
    }
    if (name === 'ono-plugin-qa') fail('NOT_A_QA_REPO', `${root} is this plugin's own repository`);
  }
  return root;
}

export class Store {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, LEDGER_DIR);
  }

  // Every ledger path is built here: plain segments only, contained in qa-ledger/,
  // and no symlink anywhere between qa-ledger/ and the target.
  p(...segments) {
    for (const s of segments) {
      if (!s || s.includes('/') || s.includes('\\') || s === '.' || s === '..') fail('INVALID_ID', `unsafe path segment "${s}"`);
    }
    const full = path.join(this.dir, ...segments);
    if (full !== this.dir && !full.startsWith(this.dir + path.sep)) fail('PATH_OUTSIDE_QA_REPO', `${full} escapes ${this.dir}`);
    let cur = this.dir;
    for (const s of ['', ...segments]) {
      cur = s ? path.join(cur, s) : cur;
      let st = null;
      try {
        st = fs.lstatSync(cur);
      } catch {
        break;
      }
      if (st.isSymbolicLink()) fail('SYMLINK_REFUSED', `${path.relative(this.root, cur)} is a symlink — the ledger never follows links`);
    }
    return full;
  }

  initialized() {
    return fs.existsSync(this.p('ledger.json'));
  }

  ensureDir() {
    if (!fs.existsSync(this.p())) fs.mkdirSync(this.p());
  }

  mkdirs(...segments) {
    let cur = [];
    for (const s of segments) {
      cur = [...cur, s];
      const full = this.p(...cur);
      if (!fs.existsSync(full)) fs.mkdirSync(full);
    }
  }

  // Create a new file; never replaces an existing one.
  create(segments, content) {
    this.mkdirs(...segments.slice(0, -1));
    const full = this.p(...segments);
    try {
      fs.writeFileSync(full, content, { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') fail('ALREADY_EXISTS', `${path.relative(this.root, full)} already exists`);
      throw e;
    }
  }

  append(segments, line) {
    fs.appendFileSync(this.p(...segments), line);
  }

  list(...segments) {
    const full = this.p(...segments);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full).sort();
  }
}

// A QA-repo-relative path to an existing file, for read-only use (plans, smoke suites).
export function resolveQaFile(root, rel) {
  if (typeof rel !== 'string' || !rel) fail('INVALID_VALUE', 'a QA-repo-relative path is required');
  const abs = path.resolve(root, rel);
  if (path.isAbsolute(rel) || !abs.startsWith(root + path.sep)) fail('PATH_OUTSIDE_QA_REPO', `${rel} is outside the QA repo`);
  if (!fs.existsSync(abs)) fail('UNKNOWN_PLAN', `${rel} does not exist in the QA repo`);
  const real = fs.realpathSync(abs);
  if (!real.startsWith(root + path.sep)) fail('PATH_OUTSIDE_QA_REPO', `${rel} resolves outside the QA repo`);
  if (!fs.statSync(real).isFile()) fail('UNKNOWN_PLAN', `${rel} is not a file`);
  const posix = path.relative(root, abs).split(path.sep).join('/');
  if (posix.startsWith(`${LEDGER_DIR}/`) || !posix.includes('/')) {
    fail('UNKNOWN_PLAN', `${rel} must be a plan inside a feature folder, e.g. <feature-slug>/test-plan.md`);
  }
  return { abs, rel: posix };
}
