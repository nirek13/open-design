// The "open in the Open Design app" handoff.
//
// A browser cannot reliably tell whether a desktop app is installed — there is
// no honest API for it. So this never *asks* the question; it attempts the
// custom scheme and watches for the page losing visibility, which is the only
// observable signal that another application took over.
//
// Two rules shape everything below:
//
//   1. The page renders first and always. The web view is never blocked on a
//      deep-link attempt, so a visitor without the app sees content
//      immediately rather than a spinner that resolves into a spinner.
//   2. A first-time anonymous visitor is never auto-redirected. Throwing a
//      stranger into an OS scheme prompt for software they do not have is
//      hostile, and on several browsers it renders as a security warning.
//      Auto-attempt happens only after an explicit opt-in, remembered locally.

/** Registered separately from the packaged renderer's internal `od://`. */
export const DEEP_LINK_SCHEME = 'opendesign';

/** How long to wait for the OS to hand off before concluding the app is absent. */
export const HANDOFF_TIMEOUT_MS = 1200;

export interface DeepLinkTarget {
  slug: string;
  versionId?: string;
}

export function buildDeepLink(target: DeepLinkTarget): string {
  const params = new URLSearchParams({ slug: target.slug });
  if (target.versionId) params.set('v', target.versionId);
  return `${DEEP_LINK_SCHEME}://open?${params.toString()}`;
}

/**
 * Parse a deep link received by the desktop app.
 *
 * This is **untrusted input from a web page**, so it is an allowlist: the host
 * must be a known action and every parameter is shape-checked. Anything
 * unrecognized returns null rather than a partially-populated object a caller
 * might act on.
 */
export function parseDeepLink(url: string): DeepLinkTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  if (parsed.host !== 'open') return null;

  const slug = parsed.searchParams.get('slug');
  if (!slug || !/^[a-z0-9-]{3,63}$/.test(slug)) return null;

  const versionId = parsed.searchParams.get('v');
  if (versionId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(versionId)) return null;

  return versionId ? { slug, versionId } : { slug };
}

/**
 * The script injected into served HTML documents.
 *
 * Kept as a string of dependency-free ES5-compatible JavaScript because it runs
 * inside someone else's generated page: it must not assume a bundler, a
 * framework, or modern syntax support, and it must not collide with page
 * globals. Everything lives inside one IIFE and one namespaced storage key.
 */
export function handoffScript(target: DeepLinkTarget): string {
  const deepLink = buildDeepLink(target);
  return `(function(){
  var KEY = 'od.openInApp.' + ${JSON.stringify(target.slug)};
  var LINK = ${JSON.stringify(deepLink)};
  var TIMEOUT = ${HANDOFF_TIMEOUT_MS};
  var attempting = false;

  function attempt(remember) {
    if (attempting) return;
    attempting = true;
    var handedOff = false;
    function onHide() { if (document.hidden) { handedOff = true; cleanup(); } }
    function cleanup() {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    }
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    window.setTimeout(function () {
      cleanup();
      attempting = false;
      if (handedOff) {
        if (remember) { try { localStorage.setItem(KEY, '1'); } catch (e) {} }
      } else {
        // No handoff: the app is not installed. Forget any stale preference so
        // the visitor is not re-prompted on every future visit.
        try { localStorage.removeItem(KEY); } catch (e) {}
        var el = document.getElementById('od-open-in-app');
        if (el) el.setAttribute('data-od-unavailable', 'true');
      }
    }, TIMEOUT);
    window.location.href = LINK;
  }

  window.__odOpenInApp = function () { attempt(true); };

  var remembered = false;
  try { remembered = localStorage.getItem(KEY) === '1'; } catch (e) {}
  // Only a returning visitor who previously opted in is auto-handed off.
  if (remembered) attempt(false);
})();`;
}

/**
 * Inject the handoff script before `</body>`, falling back to appending when the
 * document has no body tag (generated single-file pages sometimes do not).
 */
export function injectHandoff(html: string, target: DeepLinkTarget): string {
  const script = `<script>${handoffScript(target)}</script>`;
  const closing = /<\/body\s*>/i;
  if (closing.test(html)) return html.replace(closing, `${script}$&`);
  return `${html}${script}`;
}
