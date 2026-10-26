# JA LibreChat v0.8.8 attachment release

This fork release uses upstream `v0.8.8`, commit
`e8f3be08623663d4ad7f7241e693c94469b63bb0`, matching the build metadata
reported by the current production Container App. It backports the embedded MCP
file handoff and keeps the upstream frontend and application dependency lock unchanged. The pinned JA agents SDK build is included separately.

## Registry and credentials

The organization repository is `jaworldwideorg/LibreChat`. The API image is
`jaworldwide.azurecr.io/librechat/api`, following the existing `librechat/mcp/...`
and `librechat/code-interpreter/...` namespaces.

| Purpose          | Scope map                   | Token                                   | Repository actions                                         |
| ---------------- | --------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| GitHub publisher | `github-internal-librechat` | `internal-librechat-jaworldwide-github` | content/read, content/write, metadata/read, metadata/write |
| ACA puller       | `aca-internal-librechat`    | `internal-librechat-jaworldwide-aca`    | content/read, metadata/read                                |

Both maps are restricted to `librechat/api`. The registry login server is a
repository variable named `ACR_LOGIN_SERVER`; the publisher credentials are
repository secrets named `ACR_USERNAME` and `ACR_PASSWORD`. The deployment token
is separate and is not available to the workflow. No registry-wide credentials
or credentials from another project are reused.

## Build and release

The JA workflow builds the existing `Dockerfile.multi` target `api-build` for
`linux/amd64`, matching production. Pushes verify/build without publishing;
explicit workflow dispatch with `publish=true` publishes after verification.
Neither path modifies Azure Container Apps. Other upstream workflows remain
disabled on the JA fork.

Tags are `v0.8.8-ja.1` and `sha-<full-commit>`. The deployment should use the
published manifest digest, never `latest`. The runtime build metadata and OCI
labels identify the exact organization commit. Preserve the current revision's
configuration, branding mounts, secrets, scale and resources during a switch.

The existing v0.8.8 audit findings were explicitly accepted for this release on
October 26, 2026: 4 critical and 12 high findings remain. This is not an audit-clean
release. `ci/ja-release.json` pins the dependency lock and the accepted high/critical
finding fingerprint; new high/critical findings or a changed lock require review.
The complete npm audit report is retained as a workflow artifact. This policy
does not authorize future dependency changes or hide the retained findings.

## Attachment configuration

Add the following to the existing deployed `librechat.yaml` when switching to
the JA image:

```yaml
mcpSettings:
  fileTransfer:
    enabled: true
    maxFiles: 10
    maxFileBytes: 20971520
    maxTotalBytes: 52428800
```

Merge this into the existing `mcpSettings`; preserve its other settings. Embedded
binary resources require caller ownership, execute-code permission and a resolved
upload-capable Code API route. Images and legacy HTML resources keep their
existing handling. The host never fetches the resource URI. Attachment retrieval
and successful interpreter transfer remain distinct outcomes.

## Validation and rollout

Run the locked npm install, release build, workspace typechecks, focused transfer
and host-wiring tests, configuration contracts/migrations and static checks.
The Python integration cases use `pypdf==6.16.1` with real MCP/agents SDKs,
MongoDB, multipart upload, local disk and actual Python file inspection. Run the
Edge Lighthouse gate and test the packaged image locally before rollout.

Create a separately reviewed rollout plan with the new image digest, pull-token
secret reference, configuration toggle and the original revision for rollback.
Publishing an image does not authorize changing production traffic. Verify the
GitHub publish job and the ACR manifest before reporting publication success.

The upstream contribution remains separate: issue
[#17092](https://github.com/LibreChat-AI/LibreChat/issues/17092) requests assignment
before its PR. Fork-specific release workflows and registry configuration do not
belong in that upstream PR.

Primary references: [MCP embedded tool resources](https://modelcontextprotocol.io/specification/latest/server/tools),
[ACR repository-scoped tokens](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-repository-scoped-permissions),
[ACA revisions](https://learn.microsoft.com/en-us/azure/container-apps/revisions),
and [ACA containers](https://learn.microsoft.com/en-us/azure/container-apps/containers).

The v0.8.8-ja.2 release pins JA agents source 7ef2be0eec1c3e510e1771127a0b68b5e16afa01 (upstream 4.1.0), builds its locked tree, and includes its package metadata and dist in every backend build stage. Application and SDK source provenance are retained in ci/ja-release.json.
