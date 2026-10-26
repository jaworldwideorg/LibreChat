import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const source = path.resolve(process.argv[2] ?? '.ja-agents');
const installed = path.resolve('node_modules/@librechat/agents');
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
assert.equal(pkg.name, '@librechat/agents');
assert.ok(fs.existsSync(path.join(source, 'dist/cjs/main.cjs')));
const requireInstalled = createRequire(path.join(installed, 'package.json'));
for (const name of Object.keys(pkg.dependencies ?? {})) {
  try {
    requireInstalled.resolve(name);
  } catch {
    throw new Error(`Missing SDK runtime dependency: ${name}`);
  }
}
fs.rmSync(path.join(installed, 'dist'), { recursive: true, force: true });
fs.cpSync(path.join(source, 'dist'), path.join(installed, 'dist'), { recursive: true });
fs.copyFileSync(path.join(source, 'package.json'), path.join(installed, 'package.json'));
console.log(`Installed pinned JA SDK build ${pkg.version}`);
