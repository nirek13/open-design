// Environment and shared clients for the hosting edge functions.
//
// The service-role key is read here and nowhere else. It never leaves the edge
// runtime: the daemon authenticates with a Clerk token and receives only
// per-object signed URLs, so a user's machine can never hold a credential that
// reaches another user's site.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const BLOB_BUCKET = 'site-blobs';

export interface HostingEnv {
  supabaseUrl: string;
  serviceRoleKey: string;
  clerkIssuer: string;
  /** Apex domain that site subdomains hang off, e.g. `od-sites.dev`. */
  sitesDomain: string;
  /** Origins permitted to frame a published site (the product's own app). */
  frameAncestors: string[];
}

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

export function readEnv(): HostingEnv {
  return {
    supabaseUrl: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    clerkIssuer: required('CLERK_ISSUER').replace(/\/+$/, ''),
    sitesDomain: required('OD_SITES_DOMAIN').toLowerCase(),
    frameAncestors: (Deno.env.get('OD_FRAME_ANCESTORS') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

let client: SupabaseClient | null = null;

/** Service-role client. Bypasses RLS, so every caller must authorize first. */
export function serviceClient(env: HostingEnv): SupabaseClient {
  if (!client) {
    client = createClient(env.supabaseUrl, env.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
