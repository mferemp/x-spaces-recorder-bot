// Minimal service worker: enables install/standalone mode.
// Network-first, and never touches API or media routes.
const CACHE = 'spacerec-v1'

self.addEventListener('install', (e) => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Never cache API calls, file downloads, or non-GET requests.
  if (
    event.request.method !== 'GET' ||
    url.pathname.includes('/api/') ||
    url.pathname.includes('/space/file/')
  ) {
    return
  }
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const copy = resp.clone()
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {})
        return resp
      })
      .catch(() => caches.match(event.request))
  )
})
