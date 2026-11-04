// The path the app lives under, like /openmutual, or '' at the root. Set from BASE_PATH at build time.
// Next adds it to <Link>, redirect() and its own files. Plain HTML (a GET form, a cookie path) needs it by hand.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** A path inside the app, with the base in front and the trailing slash Next expects under a base. */
export function withBase(path: string): string {
  if (!BASE_PATH) return path;
  const [route, query] = path.split('?');
  const slashed = route.endsWith('/') ? route : `${route}/`;
  return `${BASE_PATH}${slashed}${query ? `?${query}` : ''}`;
}

/** Cookies stay inside the app's path, so other apps on the same host never see them. */
export const COOKIE_PATH = BASE_PATH || '/';
