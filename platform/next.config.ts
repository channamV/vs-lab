import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // PGlite ships WebAssembly files that must be loaded from node_modules, not bundled.
  serverExternalPackages: ["@electric-sql/pglite"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default function config(phase: string): NextConfig {
  // Without a platform admin nobody could set up organizations or users. Stop the build with a
  // clear message instead.
  if (phase === PHASE_PRODUCTION_BUILD && process.env.VERCEL && !process.env.PLATFORM_ADMIN_EMAILS) {
    throw new Error(
      "No platform admin: PLATFORM_ADMIN_EMAILS is not set for this Vercel deployment. " +
        "In Vercel → this project → Settings → Environment Variables, add PLATFORM_ADMIN_EMAILS " +
        "with your email address (tick Production and Preview), then redeploy.",
    );
  }
  return nextConfig;
}
