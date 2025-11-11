/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
    optimizePackageImports: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
};

export default nextConfig;
