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
  // A Vercel site without a password would be open to anyone with the link. Stop the build
  // with a clear message instead. (At runtime src/lib/auth.ts also keeps such a site locked.)
  if (phase === PHASE_PRODUCTION_BUILD && process.env.VERCEL && !process.env.ADMIN_PASSWORD) {
    throw new Error(
      "No admin password: ADMIN_PASSWORD is not set for this Vercel deployment. " +
        "In Vercel → this project → Settings → Environment Variables, add ADMIN_PASSWORD " +
        "(tick Production and Preview), then redeploy.",
    );
  }
  return nextConfig;
}
