import { z } from 'zod';
import os from 'node:os';
import axios from 'axios';
import multer from 'multer';
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import FormData from 'form-data';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { AIMessage } from '@langchain/core/messages';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolNode, createCodeExecutionTool } from '@librechat/agents';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMethods, createModels, tenantStorage } from '@librechat/data-schemas';
import { FileSources, configSchema, mcpFileTransferSchema } from 'librechat-data-provider';
import type { TFile, TMCPFileTransferPolicy } from 'librechat-data-provider';
import type { ToolSessionMap } from '@librechat/agents';
import type { CodeEnvFile } from '@librechat/agents';
import type { AddressInfo } from 'node:net';
import type { MCPToolCallResponse, EmbeddedResource } from './types';
import type { CodeExecutionContext } from '~/agents/execution';
import type { ServerRequest } from '~/types';
import {
  bindMCPFileTransfer,
  createMCPFileTransfer,
  enqueueMCPFileAttachments,
  mergeMCPFileTransfer,
} from './files';
import { createProvisionService } from '~/files/provision/service';
import { appendCodeEnvFileIdentity } from '~/files/code/identity';
import { saveLocalBuffer, writeLocalFile } from '~/storage/local';
import { createCodeApiUploadRegistry } from '~/utils';
import { appendCodeEnvFile } from '~/files/code/form';
import { formatToolContent } from './parsers';

/** Private-data-free PDF with a binary comment and one blank page. */
function syntheticPDF(): Buffer {
  let data = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const offsets: number[] = [];
  for (const [index, body] of [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>',
  ].entries()) {
    offsets.push(data.length);
    data = Buffer.concat([data, Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`)]);
  }
  return Buffer.concat([
    data,
    Buffer.from(
      'xref\n0 4\n0000000000 65535 f \n' +
        offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
        `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${data.length}\n%%EOF\n`,
    ),
  ]);
}

const resource = (
  uri = 'attachment:///fixture/test%20(1).pdf',
  bytes = syntheticPDF(),
): EmbeddedResource => ({
  type: 'resource',
  resource: { uri, mimeType: 'application/pdf', blob: bytes.toString('base64') },
});

describe('MCP file transfer', () => {
  let mongo: MongoMemoryServer;
  let root: string;
  let db: ReturnType<typeof createMethods>;
  const userId = new mongoose.Types.ObjectId().toString();
  const route: CodeExecutionContext = {
    baseUrl: 'http://code.test/v1',
    codeSessionKey: 'execute_code',
    executionProfile: 'default',
    statefulSessions: false,
  };
  const expiredAt = new Date(Date.now() + 86_400_000);

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    db = createMethods(mongoose);
    root = await mkdtemp(path.join(os.tmpdir(), 'mcp-transfer-'));
  }, 120000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await mongoose.models.File.deleteMany({});
  });

  function fixture(policy: Partial<TMCPFileTransferPolicy> = {}, selectedRoute = route) {
    const req = Object.assign(Object.create(express.request) as ServerRequest, {
      user: { id: userId, tenantId: 'synthetic-tenant' },
      body: { conversationId: 'synthetic-conversation' },
      config: {
        mcpSettings: { fileTransfer: mcpFileTransferSchema.parse({ enabled: true, ...policy }) },
      },
      app: { locals: { codeApiUploadRegistry: createCodeApiUploadRegistry() } },
    });
    const diskPath = (filepath: string) => path.join(root, filepath.replace(/^\//, ''));
    const uploaded: Buffer[] = [];
    const upload = jest.fn(async (params: Record<string, unknown>) => {
      if (!(params.stream instanceof Readable) || typeof params.filename !== 'string')
        throw new Error('invalid_test_upload');
      const chunks: Buffer[] = [];
      for await (const chunk of params.stream) chunks.push(Buffer.from(chunk));
      uploaded.push(Buffer.concat(chunks));
      return {
        storage_session_id: 'synthetic-storage',
        file_id: randomUUID(),
        filename: params.filename,
      };
    });
    const saveBuffer = jest.fn((params: Omit<Parameters<typeof saveLocalBuffer>[0], 'paths'>) =>
      saveLocalBuffer({
        ...params,
        paths: { publicPath: root, uploads: path.join(root, 'uploads') },
      }),
    );
    const deleteStorage = jest.fn(async (_req: ServerRequest, file: TFile) => {
      await unlink(diskPath(file.filepath));
    });
    const provision = createProvisionService({
      getStrategyFunctions: (source) =>
        source === FileSources.execute_code
          ? { handleFileUpload: upload }
          : { getDownloadStream: async (_req, filepath) => createReadStream(diskPath(filepath)) },
      uploadVectors: async () => undefined,
      loadAuthValues: async () => ({}),
    });
    const deps = {
      req,
      route: selectedRoute,
      source: FileSources.local,
      canExecuteCode: jest.fn(async () => true),
      getStrategyFunctions: () => ({ saveBuffer, deleteFile: deleteStorage }),
      createFile: async (file: TFile) =>
        tenantStorage.run(
          { tenantId: file.tenantId },
          async () =>
            db.createFile({
              file_id: file.file_id,
              user: new mongoose.Types.ObjectId(file.user),
              filename: file.filename,
              filepath: file.filepath,
              type: file.type,
              bytes: file.bytes,
              source: file.source,
              context: file.context,
              conversationId: file.conversationId,
              tenantId: file.tenantId,
              expiredAt: file.expiredAt ? new Date(file.expiredAt) : undefined,
            }) as Promise<TFile | null>,
        ),
      updateCodeEnvRef: async (update: Parameters<typeof db.updateFileCodeEnvRef>[0]) =>
        db.updateFileCodeEnvRef(update) as Promise<TFile | null>,
      deleteFile: jest.fn(async (id: string) => db.deleteFile(id) as Promise<TFile | null>),
      provisionToCodeEnv: provision.provisionToCodeEnv,
      deleteCodeEnvFile: jest.fn(async () => {}),
      getRetentionExpiry: async () => ({ expiredAt }),
    };
    const transfer = createMCPFileTransfer(deps)!;
    return { transfer, deps, req, upload, saveBuffer, uploaded, deleteStorage, diskPath };
  }

  it('honors server opt-out and MIME restrictions before any upload', async () => {
    const f = fixture();
    const result = { content: [resource()] };
    expect(
      (await f.transfer(result, { userId, serverPolicy: { enabled: false } })).outcomes,
    ).toEqual([]);
    expect(
      (await f.transfer(result, { userId, serverPolicy: { allowedMimeTypes: ['text/plain'] } }))
        .outcomes[0],
    ).toEqual({ status: 'unavailable', code: 'mime_not_allowed' });
    expect(f.upload).not.toHaveBeenCalled();
    const missing = resource();
    delete missing.resource.mimeType;
    expect(
      (
        await f.transfer(
          { content: [missing] },
          { userId, serverPolicy: { allowedMimeTypes: ['application/pdf'] } },
        )
      ).files,
    ).toEqual([]);
    expect(
      (
        await f.transfer(result, {
          userId,
          serverPolicy: { allowedMimeTypes: ['application/pdf'] },
        })
      ).files,
    ).toHaveLength(1);
  });

  it('preserves original PDF bytes, stores metadata and registers usable interpreter references', async () => {
    const f = fixture();
    const result = await f.transfer({ content: [resource()] }, { userId });
    expect(result.files).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({
      status: 'ready',
      filename: expect.stringMatching(/^test__1_-[0-9a-f-]+\.pdf$/),
      size_bytes: 333,
      sha256: '4e3fa972d69620ed656d8b80afe95816f7da8e65ae4369a392870096f70bdaed',
    });
    expect(f.uploaded[0]).toEqual(syntheticPDF());
    const record = (await db.getFiles({ file_id: result.outcomes[0].file_id }))!;
    expect(record[0]).toMatchObject({
      tenantId: 'synthetic-tenant',
      expiredAt,
      metadata: {
        codeEnvRefs: {
          default: { id: userId, kind: 'user', sandboxFilename: result.files[0].name },
        },
      },
    });
    expect(await readFile(f.diskPath(record[0].filepath))).toEqual(syntheticPDF());
    expect(record[0].expiresAt).toBeUndefined();
    expect(result.attachments?.[0].file_id).toBe(record[0].file_id);
    const merged = mergeMCPFileTransfer(
      formatToolContent({ content: result.content }, 'openai'),
      result,
    );
    expect(merged[0]).toContain('not_attempted');
    expect(merged[0]).not.toContain('%PDF');
    expect(merged[1]?.files).toEqual(result.files);
    expect(merged[1]?.mcp_files).toEqual(result.attachments);
  });

  it('queues registered inputs on the assistant message with graph-owned tool metadata', async () => {
    const f = fixture();
    const result = await f.transfer({ content: [resource()] }, { userId });
    const promises: Array<Promise<TFile | null>> = [];
    const emitAttachment = jest.fn();
    enqueueMCPFileAttachments({
      artifact: { mcp_files: result.attachments },
      artifactPromises: promises,
      userId,
      messageId: 'response-message',
      conversationId: 'synthetic-conversation',
      toolCallId: 'download-call',
      getOwnership: () => ({ agentId: 'executing-agent', stepId: 'download-step' }),
      emitAttachment,
    });
    expect(await Promise.all(promises)).toEqual([
      expect.objectContaining({
        file_id: result.outcomes[0].file_id,
        messageId: 'response-message',
        conversationId: 'synthetic-conversation',
        toolCallId: 'download-call',
        agentId: 'executing-agent',
        stepId: 'download-step',
      }),
    ]);
    expect(emitAttachment).toHaveBeenCalledWith(await promises[0]);
    expect(() =>
      enqueueMCPFileAttachments({
        artifact: { mcp_files: result.attachments },
        artifactPromises: [],
        userId: 'different-user',
        messageId: 'response-message',
        conversationId: 'synthetic-conversation',
        toolCallId: 'download-call',
        emitAttachment,
      }),
    ).toThrow('Invalid MCP attachment ownership');
    expect(emitAttachment).toHaveBeenCalledTimes(1);
  });

  it('does not resolve ownership for unrelated tool artifacts', () => {
    const getOwnership = jest.fn();
    enqueueMCPFileAttachments({
      artifactPromises: [],
      getOwnership,
      emitAttachment: jest.fn(),
    });
    expect(getOwnership).not.toHaveBeenCalled();
  });

  it('uses the host invocation route when a deferred loader has no construction-time route', async () => {
    const f = fixture();
    const transfer = createMCPFileTransfer({ ...f.deps, route: undefined });
    const bound = bindMCPFileTransfer(transfer, { userId, route });
    const result = await bound!({ content: [resource()] });
    expect(result.outcomes[0].status).toBe('ready');
    expect(f.uploaded[0]).toEqual(syntheticPDF());
    expect(result.files).toHaveLength(1);
  });

  it('uses the executing route instead of a route captured before an agent handoff', async () => {
    const f = fixture();
    const executingRoute = {
      ...route,
      executionProfile: 'stateful' as const,
      executionRouteKey: 'selected-deployment',
    };
    const result = await f.transfer({ content: [resource()] }, { userId, route: executingRoute });
    expect(result.outcomes[0].status).toBe('ready');
    const records = await db.getFiles({ file_id: result.outcomes[0].file_id });
    expect(records?.[0].metadata?.codeEnvRefs).toHaveProperty('selected-deployment');
    expect(records?.[0].metadata?.codeEnvRefs).not.toHaveProperty('default');
  });

  it('keeps the old behavior disabled by default and retains YAML config', () => {
    const f = fixture({ enabled: false });
    expect(createMCPFileTransfer(f.deps)).toBeUndefined();
    expect(mcpFileTransferSchema.parse(undefined).enabled).toBe(false);
    expect(
      configSchema.parse({ version: '1.3.1', mcpSettings: { fileTransfer: { enabled: true } } })
        .mcpSettings?.fileTransfer.enabled,
    ).toBe(true);
    expect(formatToolContent({ content: [resource()] }, 'openai')[0]).toContain('binary data');
  });

  it.each([
    'file:///test.pdf.pdf',
    'attachment:///x/%E6%B5%8B%E8%AF%95%20(1).pdf',
    'attachment:///x/%2E%2E%2Fsafe.pdf',
    'attachment:///x/' + 'a'.repeat(300) + '.pdf',
  ])('handles legacy and encoded filenames without local path traversal: %s', async (uri) => {
    const f = fixture();
    const result = await f.transfer({ content: [resource(uri)] }, { userId });
    expect(result.outcomes[0].status).toBe('ready');
    expect(result.files[0].name).not.toContain('/');
    const storedName = path.basename(f.saveBuffer.mock.calls[0][0].fileName);
    expect(Buffer.byteLength(storedName)).toBeLessThanOrEqual(255);
    expect(storedName).toMatch(/^[0-9a-f-]+\.bin$/);
  });

  it('reserves distinct names for duplicate resources, existing mounts and parallel calls', async () => {
    const f = fixture();
    const files: CodeEnvFile[] = [
      {
        id: 'existing',
        storage_session_id: 'prior',
        name: 'test__1_.pdf',
        kind: 'user',
        resource_id: userId,
      },
    ];
    const results = await Promise.all([
      f.transfer({ content: [resource(), resource()] }, { userId, files }),
      f.transfer({ content: [resource()] }, { userId, files }),
    ]);
    const names = results.flatMap((result) => result.files.map((file) => file.name));
    expect(new Set(names).size).toBe(3);
    expect(names).not.toContain(files[0].name);
  });

  it.each(['', '!!!!', 'YQ', 'YR=='])('rejects invalid/noncanonical base64 %s', async (blob) => {
    const f = fixture();
    const item = resource();
    if ('blob' in item.resource) item.resource.blob = blob;
    expect((await f.transfer({ content: [item] }, { userId })).outcomes[0].code).toBe(
      'invalid_payload',
    );
    expect(f.upload).not.toHaveBeenCalled();
  });

  it.each([{ maxFiles: 1 }, { maxFileBytes: 100 }, { maxTotalBytes: 400 }])(
    'enforces configurable transfer limits %j',
    async (policy) => {
      const f = fixture(policy);
      const result = await f.transfer({ content: [resource(), resource()] }, { userId });
      expect(result.outcomes.some((outcome) => outcome.code === 'limit_exceeded')).toBe(true);
      expect(f.upload.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );

  it.each(['wrong-user', 'denied', 'attached', 'no-route'])(
    'fails closed when unavailable: %s',
    async (mode) => {
      const f = fixture();
      if (mode === 'denied') f.deps.canExecuteCode.mockResolvedValue(false);
      if (mode === 'attached') f.deps.route = { ...route, environmentType: 'attached' };
      const deps = mode === 'no-route' ? { ...f.deps, route: undefined } : f.deps;
      const result = await createMCPFileTransfer(deps)!(
        { content: [resource()] },
        { userId: mode === 'wrong-user' ? 'different-user' : userId },
      );
      expect(result.outcomes[0].status).toBe('unavailable');
      expect(result.files).toEqual([]);
      expect(f.saveBuffer).not.toHaveBeenCalled();
    },
  );

  it('persists only the resolved stateful deployment reference', async () => {
    const f = fixture(
      {},
      {
        ...route,
        executionProfile: 'stateful',
        executionRouteKey: 'stateful:test',
        codeSessionKey: 'execute_code:stateful:test',
      },
    );
    const result = await f.transfer({ content: [resource()] }, { userId });
    const records = (await db.getFiles({ file_id: result.outcomes[0].file_id }))!;
    expect(records[0].metadata?.codeEnvRefs?.['stateful:test']?.executionProfile).toBe('stateful');
    expect(records[0].metadata?.codeEnvRefs?.default).toBeUndefined();
  });

  it.each(['upload', 'persist', 'owner', 'cancel'])(
    'cleans up only its own attempt on %s failure',
    async (mode) => {
      const f = fixture();
      const unrelated = await db.createFile({
        file_id: randomUUID(),
        user: new mongoose.Types.ObjectId(userId),
        filename: 'prior.pdf',
        filepath: '/prior',
        type: 'application/pdf',
        bytes: 1,
      });
      const controller = new AbortController();
      if (mode === 'upload') {
        const upload = f.upload.getMockImplementation()!;
        f.upload.mockImplementation(async (params) => {
          await upload(params);
          throw new Error('synthetic sensitive provider detail');
        });
      }
      const provision = f.deps.provisionToCodeEnv;
      const transfer = createMCPFileTransfer({
        ...f.deps,
        ...(mode === 'persist'
          ? {
              updateCodeEnvRef: async () => {
                throw new Error('synthetic sensitive database detail');
              },
            }
          : {}),
        ...(mode === 'owner'
          ? {
              provisionToCodeEnv: async (params) => {
                const uploaded = await provision(params);
                uploaded.refUpdate.ref.id = 'different-user';
                return uploaded;
              },
            }
          : {}),
        ...(mode === 'cancel'
          ? {
              updateCodeEnvRef: async (update) => {
                const stored = await f.deps.updateCodeEnvRef(update);
                controller.abort();
                return stored;
              },
            }
          : {}),
      })!;
      const pending = transfer({ content: [resource()] }, { userId, signal: controller.signal });
      if (mode === 'cancel') await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      else {
        const result = await pending;
        expect(result.files).toEqual([]);
        expect(result.outcomes[0]).toEqual({ status: 'failed', code: 'transfer_failed' });
        expect(JSON.stringify(result)).not.toContain('sensitive');
      }
      expect(f.deleteStorage).toHaveBeenCalledTimes(1);
      const records = (await db.getFiles({ user: userId }))!;
      expect(records.map((record) => record.file_id)).toEqual([unrelated?.file_id]);
      if (mode !== 'upload' && mode !== 'owner')
        expect(f.deps.deleteCodeEnvFile).toHaveBeenCalledTimes(1);
      else expect(f.deps.deleteCodeEnvFile).not.toHaveBeenCalled();
    },
  );

  it('leaves errors, image blocks and MCP Apps resources unchanged', async () => {
    const f = fixture();
    const content = [
      { type: 'image' as const, mimeType: 'image/png', data: 'AA==' },
      resource('ui://fixture/app.html'),
    ];
    const image = resource('attachment:///image.png');
    image.resource.mimeType = 'image/png';
    content.push(image);
    expect((await f.transfer({ content }, { userId })).content).toEqual(content);
    const error: MCPToolCallResponse = { isError: true, content: [resource()] };
    expect((await f.transfer(error, { userId })).content).toEqual(error.content);
    expect(f.upload).not.toHaveBeenCalled();
  });

  // This controlled external Code API executes only the fixed synthetic inspection script.
  // It is not a production sandbox. Set this variable to a Python with pypdf installed.
  describe('local Python inspection', () => {
    if (!process.env.MCP_ATTACHMENT_TEST_PYTHON) {
      it.skip('requires MCP_ATTACHMENT_TEST_PYTHON with pypdf installed', () => {
        expect(process.env.MCP_ATTACHMENT_TEST_PYTHON).toBeDefined();
      });
      return;
    }
    it.each([
      { profile: 'default', existing: false },
      { profile: 'stateful', existing: false },
      { profile: 'default', existing: true },
      { profile: 'stateful', existing: true },
    ] as const)(
      'hands a real MCP PDF into Python on $profile with existing session=$existing',
      async ({ profile, existing }) => {
        const f = fixture();
        const external = express();
        external.use(express.json());
        const uploads = new Map<string, Buffer>();
        const prior: CodeEnvFile = {
          id: 'prior-file',
          storage_session_id: 'prior-storage',
          name: 'prior.txt',
          kind: 'user',
          resource_id: userId,
        };
        if (existing) uploads.set(prior.id, Buffer.from('synthetic prior file'));
        let execFiles: CodeEnvFile[] = [];
        const parser = multer({
          storage: multer.memoryStorage(),
          limits: { fileSize: 1024, files: 1 },
        });
        external.post('/v1/upload', parser.single('file'), (req, res) => {
          expect(req.headers['user-id']).toBe(userId);
          expect(req.body.kind).toBe('user');
          expect(req.body.id).toBe(userId);
          expect(req.file?.buffer).toEqual(syntheticPDF());
          const fileId = randomUUID();
          uploads.set(fileId, req.file!.buffer);
          res.json({
            message: 'success',
            storage_session_id: 'synthetic-storage',
            files: [{ fileId, filename: req.file!.originalname }],
          });
        });
        const code =
          'import hashlib, json, sys\nfrom pypdf import PdfReader\np=sys.argv[1]\nprint(json.dumps({"sha256":hashlib.sha256(open(p,"rb").read()).hexdigest(),"pages":len(PdfReader(p).pages)}))';
        external.post('/v1/exec', async (req, res) => {
          try {
            expect(req.headers['x-codeapi-expected-profile']).toBe(profile);
            expect(req.body.code).toBe(code);
            execFiles = req.body.files;
            expect(execFiles).toHaveLength(existing ? 2 : 1);
            const pdf = execFiles.find((file) => file.name.endsWith('.pdf'))!;
            expect(uploads.get(pdf.id)).toEqual(syntheticPDF());
            if (existing) expect(execFiles).toContainEqual(prior);
            const sandbox = path.join(root, `sandbox-${randomUUID()}`);
            const mounted = await writeLocalFile(sandbox, pdf.name, uploads.get(pdf.id)!);
            const { stdout } = await promisify(execFile)(process.env.MCP_ATTACHMENT_TEST_PYTHON!, [
              '-c',
              code,
              mounted,
            ]);
            res.json({
              stdout,
              stderr: '',
              session_id: 'synthetic-execution',
              files: execFiles.map((file) => ({ ...file, inherited: true })),
            });
          } catch {
            res.status(500).json({ error: 'synthetic_inspection_failed' });
          }
        });
        const http = external.listen(0, '127.0.0.1');
        await new Promise<void>((resolve) => http.once('listening', resolve));
        const baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`;
        const selectedRoute = {
          ...route,
          baseUrl,
          executionProfile: profile,
          executionRouteKey: profile === 'default' ? 'default' : 'stateful:synthetic',
          codeSessionKey:
            profile === 'default' ? 'execute_code' : 'execute_code:stateful:synthetic',
        };
        const service = createProvisionService({
          getStrategyFunctions: (source) =>
            source === FileSources.execute_code
              ? {
                  handleFileUpload: async (params) => {
                    if (!(params.stream instanceof Readable) || typeof params.filename !== 'string')
                      throw new Error('invalid_test_upload');
                    const form = new FormData();
                    appendCodeEnvFileIdentity(form, { kind: 'user', id: userId });
                    appendCodeEnvFile(form, params.stream, params.filename);
                    const response = await axios.post<{
                      storage_session_id: string;
                      files: { fileId: string; filename: string }[];
                    }>(`${baseUrl}/upload`, form, {
                      headers: { ...form.getHeaders(), 'User-Id': userId },
                    });
                    return {
                      storage_session_id: response.data.storage_session_id,
                      file_id: response.data.files[0].fileId,
                      filename: response.data.files[0].filename,
                    };
                  },
                }
              : {
                  getDownloadStream: async (_req, filepath) =>
                    createReadStream(f.diskPath(filepath)),
                },
          uploadVectors: async () => undefined,
          loadAuthValues: async () => ({}),
        });
        const transfer = createMCPFileTransfer({
          ...f.deps,
          route: selectedRoute,
          provisionToCodeEnv: service.provisionToCodeEnv,
        })!;
        const mcp = new McpServer({ name: 'synthetic-attachments', version: '1.0.0' });
        mcp.registerTool('download_attachment', { inputSchema: z.object({}) }, async () => ({
          content: [resource()],
        }));
        const client = new Client({ name: 'synthetic-host', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcp.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          const name = 'download_attachment_mcp_synthetic';
          const download = new DynamicStructuredTool({
            name,
            description: 'Synthetic attachment download',
            schema: z.object({}),
            responseFormat: 'content_and_artifact',
            func: async () => {
              const result = await client.callTool({ name: 'download_attachment', arguments: {} });
              const transferred = await transfer(result as MCPToolCallResponse, { userId });
              return mergeMCPFileTransfer(
                formatToolContent(
                  { ...result, content: transferred.content } as MCPToolCallResponse,
                  'openai',
                ),
                transferred,
              );
            },
          });
          const sessions: ToolSessionMap = new Map();
          if (existing)
            sessions.set(selectedRoute.codeSessionKey, {
              session_id: 'prior-execution',
              files: [prior],
              lastUpdated: Date.now(),
            });
          const node = new ToolNode<{ messages: AIMessage[] }>({
            tools: [
              download,
              createCodeExecutionTool({ baseUrl, user_id: userId, executionProfile: profile }),
            ],
            sessions,
            codeSessionKey: selectedRoute.codeSessionKey,
            codeSessionToolNames: [name],
          });
          await node.invoke(
            {
              messages: [
                new AIMessage({ content: '', tool_calls: [{ id: 'download', name, args: {} }] }),
              ],
            },
            { configurable: { thread_id: 'synthetic-thread' } },
          );
          expect(sessions.get(selectedRoute.codeSessionKey)?.files).toHaveLength(existing ? 2 : 1);
          const output = await node.invoke(
            {
              messages: [
                new AIMessage({
                  content: '',
                  tool_calls: [{ id: 'inspect', name: 'execute_code', args: { lang: 'py', code } }],
                }),
              ],
            },
            { configurable: { thread_id: 'synthetic-thread' } },
          );
          expect(output.messages[0].content).toContain('"pages": 1');
          expect(JSON.stringify(output)).toContain(
            createHash('sha256').update(syntheticPDF()).digest('hex'),
          );
          expect(execFiles.find((file) => file.name.endsWith('.pdf'))?.name).toMatch(
            /^test__1_-[0-9a-f-]+\.pdf$/,
          );
          expect(sessions.get(selectedRoute.codeSessionKey)?.session_id).toBe(
            'synthetic-execution',
          );
        } finally {
          await client.close();
          await mcp.close();
          await new Promise<void>((resolve, reject) =>
            http.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
  });
});

describe('per-server transfer policy schema', () => {
  it('accepts normalized exact media types and rejects wildcard patterns', () => {
    const valid = configSchema.parse({
      version: '1.3.2',
      mcpServers: {
        fixture: {
          type: 'streamable-http',
          url: 'http://127.0.0.1:3015/mcp',
          fileTransfer: { enabled: true, allowedMimeTypes: [' Application/PDF '] },
        },
      },
    });
    expect(valid.mcpServers?.fixture.fileTransfer?.allowedMimeTypes).toEqual(['application/pdf']);
    expect(() =>
      configSchema.parse({
        version: '1.3.2',
        mcpServers: {
          fixture: {
            type: 'streamable-http',
            url: 'http://127.0.0.1:3015/mcp',
            fileTransfer: { allowedMimeTypes: ['application/*'] },
          },
        },
      }),
    ).toThrow();
  });
});
