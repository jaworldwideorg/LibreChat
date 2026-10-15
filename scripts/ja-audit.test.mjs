import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./ja-audit.mjs', import.meta.url));

function check(report, changedLock = false) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'ja-audit-test-'));
  try {
    const input = path.join(temp, 'audit.json');
    writeFileSync(input, JSON.stringify(report));
    if (changedLock) writeFileSync(path.join(temp, 'package-lock.json'), '{}');
    return spawnSync(process.execPath, [script, input], {
      cwd: changedLock ? temp : repo,
      encoding: 'utf8',
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const clean = { metadata: { vulnerabilities: { high: 0, critical: 0 } }, vulnerabilities: {} };

test('accepts a clean audit with the pinned dependency lock', () => {
  assert.equal(check(clean).status, 0);
});

test('rejects newly reported high findings', () => {
  const result = check({
    metadata: { vulnerabilities: { high: 1, critical: 0 } },
    vulnerabilities: {
      synthetic: { severity: 'high', range: '*', via: [{ source: 1 }] },
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differ from the explicitly accepted release baseline/);
});

test('rejects a changed dependency lock and invalid audit responses', () => {
  assert.match(check(clean, true).stderr, /dependency lock changed/);
  assert.match(check({ error: { code: 'synthetic_failure' } }).stderr, /valid report/);
});
