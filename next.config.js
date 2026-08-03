/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.NEXT_PUBLIC_DISABLE_EXPORT ? undefined : 'export',
  distDir: 'out',
  images: {
    unoptimized: true,
  },
  basePath: process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '',
};

module.exports = nextConfig;
