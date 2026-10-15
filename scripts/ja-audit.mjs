import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const audit = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const policy = JSON.parse(readFileSync(new URL('../ci/ja-release.json', import.meta.url), 'utf8'));
if (audit.error || !audit.metadata?.vulnerabilities) {
  throw new Error('Dependency audit did not produce a valid report');
}
const findings = Object.entries(audit.vulnerabilities ?? {})
  .filter(([, entry]) => ['high', 'critical'].includes(entry.severity))
  .map(([name, entry]) => [
    name,
    entry.severity,
    entry.range,
    entry.via.map((item) => (typeof item === 'string' ? item : item.source)).sort(),
  ])
  .sort(([a], [b]) => a.localeCompare(b, 'en'));
const fingerprint = createHash('sha256').update(JSON.stringify(findings)).digest('hex');
const lock = createHash('sha256').update(readFileSync('package-lock.json')).digest('hex');
console.log('Dependency audit counts:', JSON.stringify(audit.metadata.vulnerabilities));
if (lock !== policy.dependencyLockSha256) {
  throw new Error('JA release dependency lock changed; review the release policy');
}
if (findings.length && fingerprint !== policy.acceptedHighCriticalAuditSha256) {
  throw new Error(
    'High/critical audit findings differ from the explicitly accepted release baseline',
  );
}
console.log(
  findings.length
    ? `Existing upstream audit findings remain; publishing baseline accepted on ${policy.auditAcceptedOn}.`
    : 'No high/critical dependency audit findings.',
);
