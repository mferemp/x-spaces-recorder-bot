// Build an API URL that works everywhere: the studio preview iframe, a plain
// browser tab (whose URL may have NO trailing slash), and production.
//
// Why not just `${BASE_URL}api/...`? In dev, Vite's BASE_URL is "./" (relative).
// Inside the preview iframe the page URL ends in "/", so "./api/x" resolves
// correctly. In a normal browser tab the URL has no trailing slash, so
// "./api/x" drops the last path segment and the request 404s — which is why
// Record just spins. We fix that by anchoring to the current path treated as a
// directory, which keeps the app's mount prefix in both cases.
export function api(path: string) {
  const clean = path.replace(/^\/+/, '')
  const base = import.meta.env.BASE_URL
  // Production / configured subpath: the absolute mount is known at build time.
  if (base && base.startsWith('/')) {
    return `${base.replace(/\/+$/, '')}/api/${clean}`
  }
  // Dev / relative base: anchor to the current path AS A DIRECTORY (append a
  // trailing slash if missing) so it resolves the same with or without one.
  let dir = typeof window !== 'undefined' ? window.location.pathname : '/'
  if (!dir.endsWith('/')) dir += '/'
  return `${dir}api/${clean}`
}
