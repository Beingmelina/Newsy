const CACHE_NAME = 'newsy-v4';
self.addEventListener('install', (event) => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});
self.addEventListener('push', (event) => {
  let data = { title: 'Newsy', body: 'Your briefing is ready' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }
  const options = {
    body: data.body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag || 'briefing-reminder',
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
    actions: [
      { action: 'open', title: 'Listen Now' }
    ]
  };
  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const tag = event.notification.tag || '';
  const isLiveUpdate = tag.startsWith('live-update-');
  const url = isLiveUpdate ? '/?action=updates' : '/?action=briefing';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.navigate(url).then(c => c.focus());
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
