# Testing MCP attachment delivery

This branch requires the coordinated `@librechat/agents` source branch
`fixes/mcp-ptc-delivery` and a Code API with replay continuation-file support.
It is an integration test branch, not a standalone released SDK dependency.

Build the SDK from its locked dependencies, run `npm pack`, then install that
archive locally without changing the application lock (`npm install --no-save
--package-lock=false /absolute/path/to/archive.tgz`). If npm changes unrelated
peer resolution, restore with `npm ci` and overlay the SDK's built `dist/` into
the installed SDK solely for local integration testing. Do not commit node_modules.
Build LibreChat packages/frontend after installing the test SDK.

Global `mcpSettings.fileTransfer.enabled` remains the master switch. Existing
file count and byte limits apply. Optionally configure each server:

```yaml
mcpServers:
  fixture:
    type: streamable-http
    url: http://127.0.0.1:13015/mcp
    fileTransfer:
      enabled: true
      allowedMimeTypes:
        - application/pdf
        - application/vnd.openxmlformats-officedocument.wordprocessingml.document
```

Server settings omitted preserve the global behavior. `enabled: false` disables
that server's bridge. MIME values are normalized exact media types; wildcards are
rejected, an omitted allowlist retains supported types, and missing MIME is
rejected when an allowlist is configured. Images and MCP Apps retain their
existing handling. Resource URIs are metadata and are never fetched.

PTC downloads return registered filenames under `interpreter_files`. Open those
filenames under `/mnt/data` after awaiting the download, including inside the
same script. Do not decode base64 from the tool result. The Code API must advertise
`continuation_files: 1` on pending replay responses; older or blocking backends
fail explicitly rather than claiming the script has the file.

Parent/subagent sharing requires both deployment `endpoints.agents.fileSharing.enabled`
and the parent agent's `subagents.shareFiles: true`. Downloads are admitted as
owned inputs for their producing execution and its authorized parent ancestry.
Unrelated siblings do not receive them. Generated outputs still require explicit
`publish_artifact`; mixed downloads/generated-output batches keep that distinction.

For Softeria mail listing, request `$select=id,name,contentType,size` before
calling attachment download tools. Graph may otherwise include `contentBytes`
in ordinary JSON, which bypasses this embedded-resource bridge. This host fix does
not alter Graph queries or parse arbitrary base64 JSON.

Local verification uses synthetic PDF/DOCX, Softeria's real blob formatter with
an external Graph fixture, real MCP SDK transports, MongoDB, multipart upload,
and direct NsJail on Docker Desktop. Python and Bash same-script reads and the
parent's independent PDF hash were checked. This does not establish Entra OBO,
Lambda MicroVM, blocking PTC, or remote-bridge support. No production deployment
is part of this branch.
