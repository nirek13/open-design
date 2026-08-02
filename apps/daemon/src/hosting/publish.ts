// The publish pipeline, and the daemon's entire role in hosting.
//
//   bundle → hash → begin → upload only what is missing → commit
//
// Reading project files is the one part of publishing that cannot move to the
// cloud, because the files are on this machine's disk. Everything after the
// upload is cloud-side, which is why this module ends at `commit` and holds no
// record of what is live.
//
// Bundling reuses `buildDeployFileSet` from the bring-your-own-provider deploy
// path rather than reimplementing asset discovery. That function already
// resolves an entry document's references, inlines what must be inlined, and
// rewrites the entry to `index.html` at the site root.

import { hash as blake3Hash } from 'blake3-wasm';
import {
  buildManifest,
  describeLimitViolation,
  type ManifestInput,
  type SiteManifest,
} from '@open-design/hosting';
import type { PublishPhase } from '@open-design/contracts';
import { buildDeployFileSet, DeployError } from '../deploy.js';
import { HostingClient, HostingError, type BeginResponse } from './client.js';

/** How many blobs upload at once. Enough to saturate a normal connection,
 * few enough that a 100-file site does not open 100 sockets. */
const UPLOAD_CONCURRENCY = 6;

export interface PublishInput {
  projectsRoot: string;
  projectId: string;
  projectName: string;
  projectMetadata: unknown;
  fileName: string;
  slug?: string | undefined;
  visibility: 'public' | 'org';
  /** Deterministic disambiguator for a suggested slug. */
  slugSuffix: string;
}

export interface PublishEvent {
  phase: PublishPhase;
  uploaded: number;
  total: number;
  message: string | null;
  siteId: string | null;
}

export type PublishListener = (event: PublishEvent) => void;

export interface PublishOutcome {
  site: any;
  version: any;
  url: string | null;
}

interface PreparedFile {
  path: string;
  hash: string;
  size: number;
  contentType: string;
  data: Uint8Array;
}

function toBytes(data: Buffer | Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function hexHash(bytes: Uint8Array): string {
  return Buffer.from(blake3Hash(Buffer.from(bytes)) as Uint8Array).toString('hex');
}

/**
 * Read the project's files for this entry document and hash each one.
 *
 * Hashing here rather than server-side is what allows the incremental diff: the
 * server can answer "which of these do you already have" before a single byte
 * of content is sent.
 */
export async function prepareFiles(input: PublishInput): Promise<PreparedFile[]> {
  const files = await buildDeployFileSet(input.projectsRoot, input.projectId, input.fileName, {
    metadata: input.projectMetadata,
    includeProjectFiles: true,
  });
  return files.map((file: any) => {
    const bytes = toBytes(file.data);
    return {
      path: file.file as string,
      hash: hexHash(bytes),
      size: bytes.byteLength,
      contentType: (file.contentType as string | undefined) ?? 'application/octet-stream',
      data: bytes,
    };
  });
}

export async function publishSite(
  client: HostingClient,
  input: PublishInput,
  onEvent: PublishListener = () => {},
): Promise<PublishOutcome> {
  const emit = (event: Partial<PublishEvent> & { phase: PublishPhase }) =>
    onEvent({ uploaded: 0, total: 0, message: null, siteId: null, ...event });

  emit({ phase: 'preparing', message: 'Collecting files' });

  let prepared: PreparedFile[];
  try {
    prepared = await prepareFiles(input);
  } catch (err) {
    // buildDeployFileSet reports missing/invalid references as a DeployError.
    // Those are the publisher's problem to fix, not a server fault, so the
    // status and message pass through rather than becoming a generic 500.
    if (err instanceof DeployError) {
      throw new HostingError(err.message, err.status, 'BUNDLE_FAILED', err.details);
    }
    throw err;
  }

  const manifestInputs: ManifestInput[] = prepared.map((file) => ({
    path: file.path,
    hash: file.hash,
    size: file.size,
    contentType: file.contentType,
  }));
  const built = buildManifest(manifestInputs);
  if (built.violations.length > 0) {
    // Fail before uploading anything: telling someone their site is too large
    // after a two-minute upload is a worse experience than telling them now.
    throw new HostingError(
      built.violations.map(describeLimitViolation).join(' '),
      413,
      'LIMIT_EXCEEDED',
      built.violations,
    );
  }

  const begin: BeginResponse = await client.begin({
    slug: input.slug,
    visibility: input.visibility,
    projectId: input.projectId,
    projectName: input.projectName,
    slugSuffix: input.slugSuffix,
    entryFile: 'index.html',
    files: manifestInputs,
  });

  const byHash = new Map(prepared.map((file) => [file.hash, file]));
  const targets = begin.uploads;

  emit({
    phase: 'uploading',
    uploaded: 0,
    total: targets.length,
    siteId: begin.siteId,
    message: targets.length === 0
      ? 'No changes to upload'
      : `Uploading ${targets.length} file${targets.length === 1 ? '' : 's'}`,
  });

  let uploaded = 0;
  for (let i = 0; i < targets.length; i += UPLOAD_CONCURRENCY) {
    const batch = targets.slice(i, i + UPLOAD_CONCURRENCY);
    await Promise.all(batch.map(async (target) => {
      const file = byHash.get(target.hash);
      if (!file) {
        // The server asked for a blob that was not in the manifest we sent.
        // Uploading nothing would produce a version that 404s that path, so
        // this must abort rather than continue.
        throw new HostingError(
          `Server requested an unknown file (${target.hash.slice(0, 8)}).`,
          500,
          'UPLOAD_MISMATCH',
        );
      }
      await client.uploadBlob(begin.bucket, target, file.data, file.contentType);
      uploaded += 1;
      emit({
        phase: 'uploading',
        uploaded,
        total: targets.length,
        siteId: begin.siteId,
        message: `Uploaded ${uploaded} of ${targets.length}`,
      });
    }));
  }

  emit({
    phase: 'committing',
    uploaded,
    total: targets.length,
    siteId: begin.siteId,
    message: 'Finishing up',
  });

  const result = await client.commit({
    siteId: begin.siteId,
    manifest: begin.manifest as SiteManifest,
  });

  emit({
    phase: 'live',
    uploaded,
    total: targets.length,
    siteId: begin.siteId,
    message: result?.url ?? 'Published',
  });

  return { site: result?.site ?? null, version: result?.version ?? null, url: result?.url ?? null };
}
