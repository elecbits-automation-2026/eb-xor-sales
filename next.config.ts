import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // googleapis + pdf-parse are Node-only; keep them external to the server bundle.
  serverExternalPackages: ["googleapis", "pdf-parse", "mammoth"],
};

export default nextConfig;
