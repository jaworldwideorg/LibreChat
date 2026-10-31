# OneJA AWS migration overlay maintenance

Deployment base: commit `36e7a614ee14bd456197b3c471572c6c1dac8104`, source image `sha256:1464970ec8cea3e40318f3c67c1e8eee20a22ee978aabb88b4e25d0566733887`, release `v0.8.8-ja.2`. SDK remains the production JA `@librechat/agents`4.1.0 build from `7ef2be0eec1c3e510e1771127a0b68b5e16afa01`; the npm lock alone installs4.0.1, so run `scripts/ja-sdk.mjs` against that pinned SDK before building/testing. Node24.22.1 matches the release toolchain.

Infrastructure, Helm, data-transfer journals, rollout/rollback and credential locations belong to `jaworldwideorg/oneja-ai-infrastructure`. Application overlays are maintained here. Never copy source secrets or database rows into Git.

## File presentation overlay

- `packages/api/src/storage/s3/crud.ts` recognizes unsigned canonical URLs belonging to the configured S3 bucket as requiring signing. Foreign bucket/lookalike host URLs are not treated as canonical private references. Existing expiry behavior for signed URLs remains.
- `refreshS3FileUrls` retains the default persistence behavior for existing consumers; its response-only option returns signed URLs without replacing durable database references.
- `packages/api/src/storage/presentation.ts` selects response-only signing for S3 file listings. The legacy Express route keeps database loading/wiring and sends the returned array, avoiding the old first-response/30-minute refresh delay.
- Listing presentation follows each file's persisted `source`, independently of the current/default upload preference. Mixed-backend histories and principal overrides must not leave existing S3 references unsigned. The refresh helper retains non-S3 records unchanged.
- Native migration references retain file IDs and exact object keys; authorization must complete before presenting files. The source Azure objects are copied and verified separately before database reference changes.
- `presentStoredFileRefs` signs `filepath` values in authorized conversation, single-message and search responses, covering persisted image/tool/file attachments without serial database reads. It deduplicates repeated URLs within a response and leaves durable objects unchanged. Dates/BSON values retain their serialization behavior.
- `presentOwnedS3Url` first verifies the configured bucket/endpoint and then compares the parsed object-key owner with the authenticated user. A forged attachment in an otherwise authorized conversation must never sign another user's key. Shared-link snapshots use the existing authorized file-stream route, rather than this owner-only message signer.
- Historical source gaps are recorded separately by the infrastructure reference inventory. Do not invent placeholder content or silently drop those references. Final frozen-source verification distinguishes pre-existing missing objects from migration loss.

## Upstream merge and verification

Start future merges from this deployed base/overlay revision, preserve the SDK release pin, inspect upstream file strategy and signing changes, and reapply only behavior still needed. Pay particular attention to authentication before signing, object-key/region/tenant parsing, first response correctness, expiry refresh and avoiding signed URL persistence in the read-only presentation path.

Focused S3/presentation suites currently pass114tests, including managed canonical references, foreign/lookalike hosts, different-owner refusal, exact region/tenant keys and response-only durable-reference preservation. The three message-read route suites pass40tests, including signing only after authorization; the remaining edited message route suites pass17tests. Run the owning workspace Jest suite, API `tsc --noEmit`, scoped formatting/import checks and the file-route regression suite after updates. File/startup/message changes also require the repository Lighthouse gate before full release completion. Unit/type checks do not replace live file ownership, download, signing refresh, image/history, RAG and browser acceptance.

Produce an immutable image and update the central release manifests only after verification. Before target production writes, revert the prior image/configuration on failure. After target writes, use the central reverse data/reference migration procedure before restoring source traffic; DNS/image rollback alone is insufficient. Keep the old decryption/session keys and protected rollback snapshots until retirement gates pass.
