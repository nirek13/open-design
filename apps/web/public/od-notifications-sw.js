// Browser service workers must be served as JavaScript files. This tiny
// runtime displays task-completion and team-chat notifications, including
// Web Push delivered while no tab is open, and focuses an existing Open
// Design tab when the user clicks one.
/**
 * Whether an open window is already displaying the notification's target.
 * The app routes with pushState, so a client's URL tracks the visible view.
 * Unparseable input is treated as "not showing it" — a duplicate
 * notification is a far smaller failure than a missing one.
 */
function isShowing(clientUrl, targetUrl) {
  try {
    return (
      new URL(clientUrl).pathname
      === new URL(targetUrl, self.location.origin).pathname
    );
  } catch {
    return false;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = typeof data.title === 'string' && data.title.trim() ? data.title : 'Chat';
  const body = typeof data.body === 'string' ? data.body : '';
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : 'od-push';
  const url = typeof data.url === 'string' && data.url ? data.url : '/';

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    // Suppress only when the person is already looking at the thing the
    // notification is about. Skipping on *any* focused window meant a message
    // arrived silently whenever a Plyxl tab happened to be in front — even on
    // an unrelated view, which renders no in-page notice of its own — so the
    // mention simply never surfaced.
    if (windows.some((client) => client.focused && isShowing(client.url, url))) return;
    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      data: { ...data, url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const rawUrl = typeof data.url === 'string' ? data.url : '/';
  let targetUrl = self.location.origin;
  try {
    targetUrl = new URL(rawUrl, self.location.origin).href;
  } catch {
    /* keep origin */
  }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    const sameOrigin = windows.find((client) => {
      try {
        return new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });

    if (sameOrigin) {
      if ('navigate' in sameOrigin) {
        try {
          await sameOrigin.navigate(targetUrl);
        } catch {
          /* focus the existing tab below */
        }
      }
      return sameOrigin.focus();
    }

    if (self.clients.openWindow) {
      return self.clients.openWindow(targetUrl);
    }
    return undefined;
  })());
});
