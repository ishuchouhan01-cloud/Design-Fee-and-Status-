/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  experimental: { serverActions: { bodySizeLimit: '5mb' } },

  /**
   * Build output directory.
   *
   * `next dev` and `next build` cannot share one directory: starting the dev
   * server deletes the production BUILD_ID and rewrites the compiled server
   * output, which leaves a production server loading chunks that no longer
   * exist ("Cannot find module './372.js'").
   *
   * So the one-click launcher sets NEXT_DIST_DIR=.next-prod for both its build
   * and its start, and `npm run dev` keeps `.next` to itself. The two can now
   * run at the same time without damaging each other.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
};
export default nextConfig;
