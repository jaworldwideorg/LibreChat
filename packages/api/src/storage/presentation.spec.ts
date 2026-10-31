import { presentFileUrls, presentStoredFileRefs } from './presentation';
import { presentOwnedS3Url, refreshS3FileUrls } from './s3/crud';

jest.mock('./s3/crud', () => ({
  presentOwnedS3Url: jest.fn(async (path: string) => `${path}?signed`),
  refreshS3FileUrls: jest.fn(),
}));

describe('stored file reference presentation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('presents stored S3 files independently of the current upload preference', async () => {
    const files = [{ file_id: 'stored', source: 's3', filepath: 'canonical' }];
    const signed = [{ ...files[0], filepath: 'signed' }];
    (refreshS3FileUrls as jest.Mock).mockResolvedValueOnce(signed);
    expect(await presentFileUrls(files as Parameters<typeof presentFileUrls>[0])).toEqual(signed);
    expect(refreshS3FileUrls).toHaveBeenCalledWith(files, expect.any(Function), 0, false);
    expect(files[0].filepath).toBe('canonical');
  });

  it('signs history and content attachments without altering persisted input', async () => {
    const response = {
      messages: [
        {
          files: [{ filepath: 'owned-url' }],
          attachments: [{ filepath: 'owned-url' }],
          content: [{ image_file: { filepath: 'image-url' } }],
          text: 'owned-url',
        },
      ],
    };
    const result = await presentStoredFileRefs(response, 'owner');
    expect(result.messages[0].files[0].filepath).toBe('owned-url?signed');
    expect(result.messages[0].content[0].image_file.filepath).toBe('image-url?signed');
    expect(result.messages[0].text).toBe('owned-url');
    expect(response.messages[0].files[0].filepath).toBe('owned-url');
    expect(presentOwnedS3Url).toHaveBeenCalledTimes(2);
    expect(presentOwnedS3Url).toHaveBeenCalledWith('owned-url', 'owner');
  });

  it('preserves dates and non-plain BSON values', async () => {
    const value = { at: new Date(), absent: null, empty: [] };
    const result = await presentStoredFileRefs(value, 'owner');
    expect(result.at).toBe(value.at);
    expect(result.absent).toBeNull();
    expect(presentOwnedS3Url).not.toHaveBeenCalled();
  });
});
