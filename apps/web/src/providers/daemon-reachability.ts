// Has the daemon answered anything yet this session?
//
// Its own module so that `daemonIsLive` and the auth-context cache can both
// see the flag without importing each other, and so a test that replaces the
// whole registry module does not accidentally take this with it.

let answered = false;

/** Called after any successful daemon read. */
export function markDaemonAnswered(): void {
  answered = true;
}

export function daemonHasAnswered(): boolean {
  return answered;
}

/** Test seam: a fresh module registry per file would do this for free, but
 *  suites that share one need to reset it explicitly. */
export function resetDaemonReachability(): void {
  answered = false;
}
