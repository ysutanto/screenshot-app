import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @resvg/resvg-js ships a native .node binding that the bundler can't inline;
  // keep it external so it's required at runtime from node_modules.
  serverExternalPackages: ["@resvg/resvg-js"],
  // Force files the /download route reaches through native code into the
  // serverless function's file trace. resvg reads the font by path, and sharp
  // dlopen's libvips — neither is detectable by static analysis, and sharp's
  // own .node binding is traced automatically while the libvips shared library
  // it links against is not.
  //
  // The key is a picomatch glob matched against the route path, so the dynamic
  // segment's brackets must be escaped or `[id]` parses as a character class
  // and the entry silently matches nothing.
  outputFileTracingIncludes: {
    "/s/\\[id\\]/download": [
      "./assets/fonts/Roboto-Regular.ttf",
      // Wildcard covers whichever platform build is installed: linux-x64 on
      // Vercel, darwin-arm64 on a local Mac.
      "./node_modules/@img/sharp-libvips-*/lib/**/*",
    ],
  },
};

export default nextConfig;
