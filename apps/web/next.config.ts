import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @schemaloom/ui and the engine UI packages are published from source (their exports
  // point at src/*.ts), so Next has to compile them rather than treat them as prebuilt
  // dependencies. Everything else in the workspace ships a dist.
  transpilePackages: ['@schemaloom/ui', '@schemaloom/engine-postgresql-ui'],
  // Linting is a separate turbo task with the repo's own flat config; running it again
  // here would be a second, differently-configured pass over the same files.
  eslint: { ignoreDuringBuilds: true },
  webpack(config: { resolve: { extensionAlias?: Record<string, readonly string[]> } }) {
    // `packages/*` are ESM, so their relative imports are written `./cn.js` — the
    // specifier TypeScript will emit, not the file on disk. Webpack resolves it
    // literally and cannot find `cn.ts` without this mapping. Next applies
    // extensionAlias to app code but not to a transpiled workspace package.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
