import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // googleapis + pdf-parse are Node-only; keep them external to the server bundle.
  serverExternalPackages: ["googleapis", "pdf-parse", "mammoth", "pdfkit"],
  // The branded PDF/DOCX generators read these from disk at runtime — make
  // sure Vercel's file tracing ships them with the serverless functions.
  outputFileTracingIncludes: {
    "/api/**": ["./assets/fonts/**", "./public/xor-mark.png"],
  },
};

export default nextConfig;
