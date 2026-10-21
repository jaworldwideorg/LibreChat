import { randomUUID, createHash } from 'node:crypto';
import {
  Constants,
  FileContext,
  FileSources,
  mcpFileTransferSchema,
  getCodeEnvRefForProfile,
  isMcpAppMimeType,
} from 'librechat-data-provider';
import type { CodeEnvFile } from '@librechat/agents';
import type { TFile } from 'librechat-data-provider';
import type { ProvisionService, CodeEnvRefUpdate } from '~/files/provision/service';
import type { CodeExecutionContext } from '~/agents/execution';
import type { RetentionExpiry } from '~/files/retention';
import type { ServerRequest } from '~/types';
import type * as t from './types';
import {
  claimCodeDestination,
  createCodeDestinationSet,
  reserveCodeDestination,
} from '~/files/code/destinations';
import { sanitizeFilename, appendLeafSuffix, FILENAME_SEGMENT_MAX_BYTES } from '~/utils/files';
import { getCodeEnvUploadFilename } from '~/files/code/form';

interface MCPFileInvocation {
  userId?: string;
  signal?: AbortSignal;
  files?: CodeEnvFile[];
  serverPolicy?: { enabled?: boolean; allowedMimeTypes?: string[] };
  /** Trusted route resolved by the host for this execution, including deferred tools. */
  route?: CodeExecutionContext;
}

/** Includes schema-only deferred tools as well as eagerly loaded MCP tools. */
export function collectMCPCodeSessionToolNames(
  agents: Iterable<{
    tools?: Array<{ name: string }>;
    toolDefinitions?: Array<{ name: string }>;
    toolRegistry?: ReadonlyMap<string, { name: string }>;
  }>,
): string[] {
  const names = new Set<string>();
  for (const agent of agents) {
    for (const name of [
      ...(agent.tools ?? []).map((tool) => tool.name),
      ...(agent.toolDefinitions ?? []).map((tool) => tool.name),
      ...(agent.toolRegistry?.keys() ?? []),
    ]) {
      if (name.includes(Constants.mcp_delimiter)) names.add(name);
    }
  }
  return [...names];
}

interface MCPFileTransferOutcome {
  status: 'ready' | 'failed' | 'unavailable';
  code?:
    | 'invalid_payload'
    | 'limit_exceeded'
    | 'unavailable'
    | 'transfer_failed'
    | 'mime_not_allowed';
  file_id?: string;
  filename?: string;
  size_bytes?: number;
  sha256?: string;
}

export interface MCPFileTransferResult {
  content: t.ToolContentPart[];
  files: CodeEnvFile[];
  outcomes: MCPFileTransferOutcome[];
  attachments?: TFile[];
}

export type MCPFileTransfer = (
  result: t.MCPToolCallResponse,
  invocation: MCPFileInvocation,
) => Promise<MCPFileTransferResult>;

export type MCPBoundFileTransfer = (
  result: t.MCPToolCallResponse,
  serverPolicy?: MCPFileInvocation['serverPolicy'],
) => Promise<MCPFileTransferResult>;

interface BufferStorage {
  saveBuffer?: (params: {
    userId: string;
    buffer: Buffer;
    fileName: string;
    basePath: 'uploads';
  }) => Promise<string>;
  deleteFile?: (req: ServerRequest, file: TFile) => Promise<void>;
}

interface MCPFileDependencies {
  req?: ServerRequest;
  source?: FileSources;
  route?: CodeExecutionContext;
  canExecuteCode: () => Promise<boolean>;
  getStrategyFunctions: (source: string) => BufferStorage;
  createFile: (file: TFile) => Promise<TFile | null>;
  updateCodeEnvRef: (update: CodeEnvRefUpdate) => Promise<TFile | null>;
  deleteFile: (id: string) => Promise<TFile | null>;
  provisionToCodeEnv: ProvisionService['provisionToCodeEnv'];
  deleteCodeEnvFile: (req: ServerRequest, file: TFile) => Promise<void>;
  getRetentionExpiry: (req: ServerRequest) => Promise<RetentionExpiry>;
}

function isFileResource(item: t.ToolContentPart): item is t.EmbeddedResource {
  return (
    item.type === 'resource' &&
    'blob' in item.resource &&
    !item.resource.uri.startsWith('ui://') &&
    !isMcpAppMimeType(item.resource.mimeType ?? '') &&
    !item.resource.mimeType?.toLowerCase().startsWith('image/')
  );
}

function decodeFile(
  resource: t.ResourceContents,
  maxBytes: number,
): { ok: true; buffer: Buffer } | { ok: false; code: 'invalid_payload' | 'limit_exceeded' } {
  if (!('blob' in resource) || !resource.blob) return { ok: false, code: 'invalid_payload' };
  if (resource.blob.length > 4 * Math.ceil(maxBytes / 3))
    return { ok: false, code: 'limit_exceeded' };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(resource.blob)) return { ok: false, code: 'invalid_payload' };
  const buffer = Buffer.from(resource.blob, 'base64');
  if (!buffer.length || buffer.toString('base64') !== resource.blob)
    return { ok: false, code: 'invalid_payload' };
  if (buffer.length > maxBytes) return { ok: false, code: 'limit_exceeded' };
  return { ok: true, buffer };
}

function resourceFilename(uri: string): string {
  if (uri.length > 8192) return 'attachment';
  try {
    const leaf = new URL(uri).pathname.split('/').pop() ?? 'attachment';
    return sanitizeFilename(
      decodeURIComponent(leaf).replace(/\\/g, '/').split('/').pop() ?? 'attachment',
    );
  } catch {
    return 'attachment';
  }
}

/** Binds a raw MCP result to the current authenticated tool invocation. */
export function bindMCPFileTransfer(
  transfer: MCPFileTransfer | undefined,
  invocation: MCPFileInvocation,
): MCPBoundFileTransfer | undefined {
  return transfer
    ? (result, serverPolicy) => transfer(result, { ...invocation, serverPolicy })
    : undefined;
}

/** Reuses host storage and provisioning; remote resource URIs are never opened or fetched. */
export function createMCPFileTransfer(deps: MCPFileDependencies): MCPFileTransfer | undefined {
  const { req, source } = deps;
  const policy = mcpFileTransferSchema.parse(req?.config?.mcpSettings?.fileTransfer);
  if (!policy.enabled) return undefined;
  const destinations = createCodeDestinationSet();

  return async (result, invocation) => {
    const route = invocation.route ?? deps.route;
    if (invocation.serverPolicy?.enabled === false)
      return { content: result?.content ?? [], files: [], outcomes: [] };
    const content: t.ToolContentPart[] = [];
    const files: CodeEnvFile[] = [];
    const outcomes: MCPFileTransferOutcome[] = [];
    const attachments: TFile[] = [];
    if (result?.isError) return { content: result.content ?? [], files, outcomes };
    if (!result?.content?.some(isFileResource))
      return { content: result?.content ?? [], files, outcomes };
    for (const file of invocation.files ?? []) reserveCodeDestination(destinations, file.name);
    const user = req?.user;
    const available =
      user?.id != null &&
      invocation.userId === user.id &&
      route != null &&
      route.environmentType !== 'attached' &&
      source != null &&
      (await deps.canExecuteCode());
    let count = 0;
    let totalBytes = 0;

    for (const item of result?.content ?? []) {
      if (!isFileResource(item)) {
        content.push(item);
        continue;
      }
      invocation.signal?.throwIfAborted();
      const allowlist = invocation.serverPolicy?.allowedMimeTypes;
      const mime = item.resource.mimeType?.split(';', 1)[0].trim().toLowerCase();
      if (allowlist && (!mime || !allowlist.includes(mime))) {
        outcomes.push({ status: 'unavailable', code: 'mime_not_allowed' });
        continue;
      }
      count += 1;
      if (count > policy.maxFiles) {
        if (count === policy.maxFiles + 1)
          outcomes.push({ status: 'failed', code: 'limit_exceeded' });
        continue;
      }
      if (!available || !req || !route || !source || !user?.id) {
        outcomes.push({ status: 'unavailable', code: 'unavailable' });
        continue;
      }
      const decoded = decodeFile(item.resource, policy.maxFileBytes);
      if (!decoded.ok) {
        outcomes.push({ status: 'failed', code: decoded.code });
        continue;
      }
      const { buffer } = decoded;
      totalBytes += buffer.length;
      if (totalBytes > policy.maxTotalBytes) {
        outcomes.push({ status: 'failed', code: 'limit_exceeded' });
        continue;
      }
      const id = randomUUID();
      // Agents can transfer concurrently before seeing one another's session updates.
      const uniqueName = appendLeafSuffix(
        getCodeEnvUploadFilename(resourceFilename(item.resource.uri)),
        `-${id}`,
        FILENAME_SEGMENT_MAX_BYTES,
      );
      const name = claimCodeDestination(destinations, uniqueName, id);
      const storage = deps.getStrategyFunctions(source);
      let stored: TFile | undefined;
      let registered = false;
      let uploaded = false;
      try {
        if (!storage.saveBuffer || !storage.deleteFile) throw new Error('unsupported_storage');
        const retention = await deps.getRetentionExpiry(req);
        invocation.signal?.throwIfAborted();
        const filepath = await storage.saveBuffer({
          userId: user.id,
          buffer,
          fileName: `${id}.bin`,
          basePath: 'uploads',
        });
        stored = {
          file_id: id,
          user: user.id,
          tenantId: user.tenantId,
          filename: name,
          filepath,
          source,
          bytes: buffer.length,
          embedded: false,
          object: 'file',
          usage: 0,
          type: item.resource.mimeType ?? 'application/octet-stream',
          context: FileContext.message_attachment,
          conversationId: req.body?.conversationId,
          ...retention,
        };
        invocation.signal?.throwIfAborted();
        const record = await deps.createFile(stored);
        if (!record || record.file_id !== id) throw new Error('registration_failed');
        registered = true;
        // Provisioning diagnostics must not retain the resource's original filename.
        const provisioned = await deps.provisionToCodeEnv({
          req,
          file: { ...stored, filename: id },
          route,
          sandboxFilename: name,
          signal: invocation.signal,
        });
        stored = { ...stored, metadata: { ...stored.metadata, ...provisioned.referenceSet } };
        const ref = getCodeEnvRefForProfile(
          stored.metadata,
          route.executionRouteKey ?? route.executionProfile ?? 'default',
        );
        if (
          !ref ||
          ref.id !== user.id ||
          ref.kind !== 'user' ||
          !ref.storage_session_id ||
          !ref.file_id
        ) {
          throw new Error('invalid_upload_reference');
        }
        uploaded = true;
        const persisted = await deps.updateCodeEnvRef(provisioned.refUpdate);
        if (!persisted) throw new Error('reference_registration_failed');
        invocation.signal?.throwIfAborted();
        const mountedName = provisioned.sandboxFilename;
        if (mountedName !== name) throw new Error('unexpected_upload_filename');
        attachments.push({ ...stored, filename: mountedName });
        files.push({
          id: ref.file_id,
          storage_session_id: ref.storage_session_id,
          name: mountedName,
          kind: 'user',
          resource_id: user.id,
        });
        outcomes.push({
          status: 'ready',
          file_id: id,
          filename: mountedName,
          size_bytes: buffer.length,
          sha256: createHash('sha256').update(buffer).digest('hex'),
        });
      } catch {
        if (stored) {
          await Promise.allSettled([
            ...(uploaded ? [deps.deleteCodeEnvFile(req, stored)] : []),
            ...(registered ? [deps.deleteFile(id)] : []),
            ...(storage.deleteFile ? [storage.deleteFile(req, stored)] : []),
          ]);
        }
        invocation.signal?.throwIfAborted();
        outcomes.push({ status: 'failed', code: 'transfer_failed' });
      }
    }
    return { content, files, outcomes, attachments };
  };
}

export function mergeMCPFileTransfer(
  formatted: t.FormattedContentResult,
  transferred?: MCPFileTransferResult,
): t.FormattedContentResult {
  if (!transferred?.outcomes.length) return formatted;
  const [text, artifacts] = formatted;
  const summary = JSON.stringify({
    attachment_retrieval: 'succeeded',
    interpreter_files: transferred.outcomes,
    inspection: 'not_attempted',
    limitation: transferred.outcomes.some((outcome) => outcome.status !== 'ready')
      ? 'Some attachments could not be transferred. No usable file reference is available for failed transfers.'
      : 'Registered files are included in the next code execution input. Open their returned filenames with the code tool. These are downloaded inputs, not generated outputs: do not copy them merely to publish_artifact. When run file sharing is enabled, the authorized parent discovers them through list_run_files.',
  });
  return [
    `${text}\n\n${summary}`,
    {
      ...artifacts,
      ...(transferred.files.length
        ? { files: transferred.files, session_id: transferred.files[0].storage_session_id }
        : {}),
      ...(transferred.attachments?.length ? { mcp_files: transferred.attachments } : {}),
    },
  ];
}

/** Uses the normal tool-end attachment queue so transferred inputs survive later turns. */
export function enqueueMCPFileAttachments({
  artifact,
  artifactPromises,
  userId,
  messageId,
  conversationId,
  toolCallId,
  getOwnership,
  canEmit,
  emitAttachment,
}: {
  artifact?: { mcp_files?: TFile[] };
  artifactPromises: Array<Promise<TFile | null>>;
  userId?: string;
  messageId?: string;
  conversationId?: string;
  toolCallId?: string;
  getOwnership?: () => { agentId?: string; stepId?: string };
  canEmit?: () => boolean;
  emitAttachment: (file: TFile) => void;
}): void {
  const files = artifact?.mcp_files;
  if (!files?.length) return;
  const ownership = getOwnership?.();
  for (const file of files) {
    if (file.user !== userId || !messageId || !conversationId || !toolCallId)
      throw new Error('Invalid MCP attachment ownership');
    const attachment = { ...file, ...ownership, messageId, conversationId, toolCallId };
    artifactPromises.push(Promise.resolve(attachment));
    if (canEmit?.() !== false) emitAttachment(attachment);
  }
}
