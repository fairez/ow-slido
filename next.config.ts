import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // e2e runs use their own build dir so they never collide with a running `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // `next dev` answers 403 to JS chunks requested from any origin but localhost, so pages opened via a
  // server IP or hostname never hydrate. 127.0.0.1 is always allowed (SSH tunnels); list other hosts (comma separated) in ALLOWED_DEV_ORIGINS.
  allowedDevOrigins: [
    "127.0.0.1",
    ...(process.env.ALLOWED_DEV_ORIGINS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  ],
};

export default nextConfig;
