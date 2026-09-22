import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @resvg/resvg-js ships a native .node binding that the bundler can't inline;
  // keep it external so it's required at runtime from node_modules.
  serverExternalPackages: ["@resvg/resvg-js"],
  // Ensure files the /download route loads through native code are included in
  // the serverless function's file trace. Both are opened by path at runtime
  // (resvg reads the font, sharp dlopen's libvips), which the tracer cannot
  // detect, so they must be listed explicitly. The @img globs target the
  // linux-x64 binaries Vercel installs at build time — they resolve to nothing
  // on a macOS dev machine, where the darwin build is used instead.
  outputFileTracingIncludes: {
    "/s/[id]/download": [
      "./assets/fonts/Roboto-Regular.ttf",
      "./node_modules/@img/sharp-linux-x64/**",
      "./node_modules/@img/sharp-libvips-linux-x64/**",
    ],
  },
};

export default nextConfig;
