import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@openmutual/shared'],
  serverExternalPackages: ['node:sqlite'],
  poweredByHeader: false,
};

export default config;
