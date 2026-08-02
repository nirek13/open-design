// Where the hosting cloud lives, from this daemon's point of view.
//
// The daemon holds no hosting credentials. It knows two URLs and forwards the
// caller's own Clerk token; every privileged operation happens in an edge
// function that authorizes the caller itself. Nothing here should ever grow a
// service key, a storage secret, or a database URL — if a change seems to need
// one, the logic belongs in an edge function instead.

export interface HostingConfig {
  /** Base URL of the deployed edge functions, e.g. `https://<ref>.functions.supabase.co`. */
  functionsUrl: string;
  /** Apex domain that site subdomains hang off, e.g. `od-sites.dev`. */
  sitesDomain: string;
  /** Supabase project URL, used to build storage upload endpoints. */
  supabaseUrl: string;
  /** Anon key. Public by construction; Supabase requires it as an API gateway
   * key, and it grants nothing on its own because RLS denies every write. */
  anonKey: string;
}

export type HostingConfigResult =
  | { configured: true; config: HostingConfig }
  | { configured: false; missing: string[] };

const REQUIRED = [
  'OD_HOSTING_FUNCTIONS_URL',
  'OD_HOSTING_SUPABASE_URL',
  'OD_HOSTING_ANON_KEY',
  'OD_SITES_DOMAIN',
] as const;

export function readHostingConfig(env: NodeJS.ProcessEnv = process.env): HostingConfigResult {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) return { configured: false, missing };
  return {
    configured: true,
    config: {
      functionsUrl: env.OD_HOSTING_FUNCTIONS_URL!.trim().replace(/\/+$/, ''),
      supabaseUrl: env.OD_HOSTING_SUPABASE_URL!.trim().replace(/\/+$/, ''),
      anonKey: env.OD_HOSTING_ANON_KEY!.trim(),
      sitesDomain: env.OD_SITES_DOMAIN!.trim().toLowerCase(),
    },
  };
}

export function publicSiteUrl(config: HostingConfig, slug: string): string {
  return `https://${slug}.${config.sitesDomain}`;
}
