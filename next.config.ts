import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "src/sw.ts",
  swDest: "public/sw.js",
  // No SW in dev: Serwist's webpack plugin never runs under Turbopack
  // (`next dev`), and this keeps it off even under `next dev --webpack`.
  disable: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  // Serwist injects a webpack config (used only by `next build --webpack`);
  // this empty turbopack config tells `next dev` (Turbopack) that's intended.
  turbopack: {},
  // Client Router Cache: dynamic (uncached-by-default) segments stay fresh
  // in the client cache for 30s, static/prerendered ones for 180s. Paired
  // with the audited revalidatePath coverage above — mutations bust the
  // cache immediately, this just controls unmutated back/forward nav reuse.
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
    // Plan 8 ruling 18: the import wizard posts the statement (≤ 1 MB, the
    // cap the action names) as multipart to a server action; the default
    // 1 MB body limit would reject a file at the cap with Next's own error
    // instead of the named one. 2 MB is headroom for the fields, no more.
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default withSerwist(nextConfig);
