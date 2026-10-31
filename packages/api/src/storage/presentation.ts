import { FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import { presentOwnedS3Url, refreshS3FileUrls } from './s3/crud';

/** Resolve response-only download URLs without replacing durable storage references. */
export async function presentFileUrls(files: TFile[], strategy: FileSources): Promise<TFile[]> {
  if (strategy !== FileSources.s3) {
    return files;
  }
  return refreshS3FileUrls(files, async () => undefined, 0, false);
}

/**
 * Resolve stored message attachment URLs after conversation authorization.
 * The object key must also belong to the authenticated owner, so a forged
 * attachment cannot turn an authorized message into another user's download.
 * No database read or write is performed; durable references stay unsigned.
 */
export async function presentStoredFileRefs<T>(value: T, ownerId: string): Promise<T> {
  const urls = new Map<string, Promise<string>>();
  async function visit(input: unknown): Promise<unknown> {
    if (Array.isArray(input)) {
      return Promise.all(input.map(visit));
    }
    if (
      input == null ||
      typeof input !== 'object' ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      return input;
    }
    const fields = await Promise.all(
      Object.entries(input).map(async ([key, item]) => {
        if (key === 'filepath' && typeof item === 'string') {
          let resolved = urls.get(item);
          if (!resolved) {
            resolved = presentOwnedS3Url(item, ownerId);
            urls.set(item, resolved);
          }
          return [key, await resolved] as const;
        }
        return [key, await visit(item)] as const;
      }),
    );
    return Object.fromEntries(fields);
  }
  return (await visit(value)) as T;
}
