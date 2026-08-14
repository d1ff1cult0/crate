/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source, so Next must compile them.
  transpilePackages: ['@crate/core', '@crate/db', '@crate/integrations'],
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,

  // Prisma's query engine is a native binary and ioredis/bullmq open sockets — none of
  // them can be bundled into the server build.
  serverExternalPackages: ['@prisma/client', 'ioredis', 'bullmq'],

  webpack: (config) => {
    // The shared packages use NodeNext-style ".js" specifiers that actually resolve to
    // ".ts" sources. Webpack needs to be told, or every cross-file import in
    // @crate/core fails to resolve.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    }
    return config
  },
}

export default nextConfig
