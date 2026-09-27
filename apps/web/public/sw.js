// Kill switch. SchemaLoom has no service worker. A browser that still has one registered
// for this origin (left by another app once served on localhost:3000) re-fetches this
// URL to update it; getting THIS script makes it unregister itself and reload its pages,
// so it stops intercepting requests to the API.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) client.navigate(client.url);
    })(),
  );
});
