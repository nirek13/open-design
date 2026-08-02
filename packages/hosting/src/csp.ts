// Response security headers for a hosted site.
//
// These are deliberately *looser* than the daemon's `/s/:token` policy, and the
// reason is structural rather than a relaxation of standards. `/s/:token` is
// served from the daemon's own origin, so `connect-src 'none'`
// (see apps/daemon/src/server.ts) is what stops a shared page from calling back
// into organization data. A hosted site lives on a separate registrable domain
// with no API adjacent to it, so `connect-src 'self'` grants a published app
// the ability to talk to its own origin without exposing anything.
//
// Everything that constrains *escalation* stays locked: no plugins, no framing
// by third parties, no base-tag hijacking, no MIME sniffing.

export interface SecurityHeaderOptions {
  /**
   * Allow the page to be framed by the product's own origin, so an in-app
   * preview can embed the live site. Any other embedder stays blocked.
   */
  frameAncestors?: readonly string[];
}

export function siteContentSecurityPolicy(options: SecurityHeaderOptions = {}): string {
  const frameAncestors = options.frameAncestors?.length
    ? options.frameAncestors.join(' ')
    : "'none'";
  return [
    "default-src 'self' data: blob:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline' https:",
    // Generated apps routinely inline scripts and use `eval` through bundled
    // template engines. Locking these down would break the majority of what
    // people publish; the isolation that matters is the separate origin.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
    "connect-src 'self' https:",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
}

export function siteSecurityHeaders(options: SecurityHeaderOptions = {}): Record<string, string> {
  return {
    'Content-Security-Policy': siteContentSecurityPolicy(options),
    // Without this, an uploaded `.txt` can be re-interpreted as HTML by a
    // sniffing browser, which turns any file upload into stored XSS.
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // A published page has no business reading hardware or location.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}
