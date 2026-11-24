/** Cache rules for the web shell. public/sw.js must keep the same decisions. */
export function shouldCache(rawUrl: string, origin: string, contentType = ''): boolean {
  if (contentType.toLowerCase().includes('text/event-stream')) return false;
  let url: URL;
  try {
    url = new URL(rawUrl, origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;
  if (url.pathname.includes('/media/')) return false;
  if (url.searchParams.get('download') === '1') return false;
  if (url.pathname === '/' || url.pathname === '/index.html') return true;
  if (url.pathname.startsWith('/icons/')) return true;
  if (url.pathname.endsWith('.webmanifest')) return true;
  if (url.pathname.endsWith('.html') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) return true;
  return false;
}
