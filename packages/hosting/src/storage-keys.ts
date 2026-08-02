// Storage object naming.
//
// Every blob lives under its owning site's prefix, and its name is the content
// hash. That layout does two jobs at once:
//
//   - Deleting a site is a prefix delete, with no risk of orphaning bytes that
//     another site still references, because nothing is shared across sites.
//   - A signed upload URL is scoped to one exact key. Since the key IS the
//     hash, the worst a misbehaving client can do with a signed URL is write
//     wrong bytes into its own site's blob — it cannot reach another site's
//     prefix, and it cannot overwrite a *different* blob of its own.
//
// Cross-site deduplication was considered and rejected: sharing one blob
// between two sites would mean reference counting, and a delete bug would then
// break a stranger's live site rather than only your own.

export const SITE_BLOB_PREFIX = 'sites';

/** Hex blake3, as produced by the daemon publisher. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SITE_ID_PATTERN = /^[0-9a-f-]{36}$/;

export function storageKeyFor(siteId: string, hash: string): string {
  if (!SITE_ID_PATTERN.test(siteId)) {
    throw new Error(`invalid site id: ${JSON.stringify(siteId)}`);
  }
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(`invalid blob hash: ${JSON.stringify(hash)}`);
  }
  return `${SITE_BLOB_PREFIX}/${siteId}/blobs/${hash}`;
}
