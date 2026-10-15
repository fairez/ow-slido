import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // e2e runs use their own build dir so they never collide with a running `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
