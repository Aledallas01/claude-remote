/// <reference lib="webworker" />
// Service worker: offline app shell (Workbox precache) + push notifications.
// Built by vite-plugin-pwa (injectManifest); excluded from the app's type-check.
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

interface RequestPush {
  type: 'request';
  kind: 'permission' | 'question';
  requestId: string;
  sessionId: string | null;
  toolName: string;
  session: string;
  detail: string;
}
interface DonePush {
  type: 'done';
  sessionId: string | null;
  session: string;
  detail: string;
}

const it = (navigator.language || '').toLowerCase().startsWith('it');
const text = {
  question: it ? 'Claude ha una domanda' : 'Claude has a question',
  approve: it ? 'Approvazione richiesta' : 'Approval needed',
  done: it ? 'Claude ha finito' : 'Claude finished',
};

// The agent pushes one message per pending permission prompt / question, and one when a
// turn ends in a session that is being used from here.
self.addEventListener('push', (event: PushEvent) => {
  let data: RequestPush | DonePush | null = null;
  try {
    data = event.data ? (event.data.json() as RequestPush | DonePush) : null;
  } catch {
    data = null;
  }
  if (!data) return;
  if (data.type === 'done') {
    const url = `/?open=${encodeURIComponent(data.sessionId || '')}`;
    event.waitUntil(
      self.registration.showNotification(data.session ? `${text.done} · ${data.session}` : text.done, {
        body: data.detail,
        tag: `done-${data.sessionId || ''}`, // one per session: a newer turn replaces the older notice
        icon: '/favicon.svg',
        badge: '/favicon.svg',
        data: { url, sessionId: data.sessionId, requestId: null },
      } as NotificationOptions),
    );
    return;
  }
  if (data.type !== 'request') return;
  const title = data.kind === 'question' ? text.question : `${text.approve}: ${data.toolName}`;
  const body = [data.session, data.detail].filter(Boolean).join('\n');
  const url = `/?open=${encodeURIComponent(data.sessionId || '')}&req=${encodeURIComponent(data.requestId)}`;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.requestId, // one notification per request; a later push for it replaces it
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { url, sessionId: data.sessionId, requestId: data.requestId },
      requireInteraction: data.kind === 'permission',
    } as NotificationOptions),
  );
});

// Tap: focus the app if it is open and tell it which request to show, otherwise open it.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const d = (event.notification.data || {}) as { url?: string; sessionId?: string | null; requestId?: string };
  const url = d.url || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = all.find((c) => 'focus' in c) as WindowClient | undefined;
      if (client) {
        await client.focus();
        client.postMessage({ type: 'open', sessionId: d.sessionId || null, requestId: d.requestId || null });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
