// Workspace identity mark: the company's harvested logo when we have one,
// otherwise a live favicon while they type a website, otherwise the Substrate
// glyph. Used on the setup card and the sidebar.

import { useEffect, useState } from 'react';
import { websiteFaviconUrl } from '../../runtime/brand-references';

interface Props {
  orgId?: string | null;
  /** Cache-bust the harvested mark after the org row changes. */
  markVersion?: number | string | null;
  websiteUrl?: string | null;
  className?: string;
  size?: number;
  'data-testid'?: string;
}

export function orgMarkUrl(orgId: string, markVersion?: number | string | null): string {
  const base = `/api/orgs/${encodeURIComponent(orgId)}/mark`;
  if (markVersion === undefined || markVersion === null || markVersion === '') return base;
  return `${base}?v=${encodeURIComponent(String(markVersion))}`;
}

export function OrgMark({
  orgId,
  markVersion,
  websiteUrl,
  className,
  size = 64,
  'data-testid': testId,
}: Props) {
  const harvested = orgId ? orgMarkUrl(orgId, markVersion) : null;
  const favicon = websiteFaviconUrl(websiteUrl, size);
  const [failedHarvest, setFailedHarvest] = useState(false);
  const [failedFavicon, setFailedFavicon] = useState(false);

  useEffect(() => {
    setFailedHarvest(false);
  }, [harvested]);

  useEffect(() => {
    setFailedFavicon(false);
  }, [favicon]);

  const src = harvested && !failedHarvest ? harvested : favicon && !failedFavicon ? favicon : null;
  const usingHarvest = Boolean(harvested && !failedHarvest && src === harvested);

  if (!src) {
    return (
      <span
        className={className ? `${className} od-brand-glyph` : 'od-brand-glyph'}
        aria-hidden="true"
        data-testid={testId}
      />
    );
  }

  return (
    <img
      className={className}
      src={src}
      alt=""
      width={size}
      height={size}
      decoding="async"
      {...(usingHarvest ? {} : { referrerPolicy: 'no-referrer' as const })}
      onError={() => {
        if (usingHarvest) setFailedHarvest(true);
        else setFailedFavicon(true);
      }}
      data-testid={testId}
    />
  );
}
