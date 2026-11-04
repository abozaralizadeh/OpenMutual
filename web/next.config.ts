import type { NextConfig } from 'next';

// BASE_PATH lets the app live under a path on a shared host, like /openmutual/. Next needs it
// without the trailing slash, and it's baked in at build time, so build with the same value you run.
const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
if (basePath && !/^(\/[A-Za-z0-9._-]+)+$/.test(basePath)) throw new Error(`BASE_PATH must look like /openmutual/, got ${process.env.BASE_PATH}`);

const config: NextConfig = {
  transpilePackages: ['@openmutual/shared'],
  serverExternalPackages: ['node:sqlite'],
  poweredByHeader: false,
  basePath: basePath || undefined,
  // Under a path, every page ends in a slash, so /openmutual/ is the home page and the proxy's
  // 301 from /openmutual can't loop with Next's own trailing slash redirect.
  trailingSlash: Boolean(basePath),
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default config;
