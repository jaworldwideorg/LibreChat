# JA LibreChat v0.8.9

This release upgrades the pushed v0.8.8-ja.4 customizations to upstream v0.8.9. It retains MCP binary-resource admission to Code Interpreter, programmatic tool calls and shared subagent file sessions. The Agents SDK is upstream 4.2.7 with the existing pushed JA file-delivery patch, pinned by commit in `ci/ja-release.json`.

The release reconciles file transfer hooks with upstream MCP Apps, scheduled tool authorization and OAuth prompt handling. Production retains branding, EFS configuration, identity keys, tools, memories, skills and stored chats.

`.github/workflows/ja-release.yml` builds packages and the frontend, checks TypeScript and static rules, tests attachment handoff, shared sessions, host wiring and configuration migrations, and audits locked runtime dependencies before publishing an immutable ECR image. The upgraded lock reported zero vulnerabilities locally. No prior audit exception is carried forward.

Publish a `v0.8.9-ja.<release>` tag from this branch after verification. Deployment is separate: review the owning LibreChat-IaC plan, require healthy overlap, verify authentication/configuration and synthetic chat/file execution, and retain the previous image for rollback.

MCP file transfer remains opt-in under `mcpSettings.fileTransfer`; per-server overrides and MIME restrictions remain supported. Production policies are retained. The v0.8.9 MCP name-reservation migration is required only if a legacy reservation index exists; production had no reservation records or indexes during the upgrade check.
