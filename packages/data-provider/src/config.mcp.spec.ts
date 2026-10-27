import { mcpFileTransferSchema } from './config';

describe('MCP file transfer defaults', () => {
  it.each([undefined, {}])('keeps omitted policy disabled with bounded limits', (input) => {
    expect(mcpFileTransferSchema.parse(input)).toEqual({
      enabled: false,
      maxFiles: 10,
      maxFileBytes: 20 * 1024 * 1024,
      maxTotalBytes: 50 * 1024 * 1024,
    });
  });

  it('applies defaults while retaining an explicit opt-in', () => {
    expect(mcpFileTransferSchema.parse({ enabled: true, maxFiles: 3 })).toEqual({
      enabled: true,
      maxFiles: 3,
      maxFileBytes: 20 * 1024 * 1024,
      maxTotalBytes: 50 * 1024 * 1024,
    });
  });

  it.each([{ maxFiles: 0 }, { maxFiles: 101 }, { maxFileBytes: 0 }, { enabled: 'true' }])(
    'rejects invalid policy values',
    (input) => {
      expect(mcpFileTransferSchema.safeParse(input).success).toBe(false);
    },
  );
});
