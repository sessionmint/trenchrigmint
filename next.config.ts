import type { NextConfig } from "next";

const rawBasePath = process.env.NEXT_PUBLIC_APP_BASEPATH || process.env.NEXT_PUBLIC_TRENCHRIG_PATH || "";
const normalizedBasePath = rawBasePath.trim()
  ? `/${rawBasePath.trim().replace(/^\/+|\/+$/g, "")}`
  : "";

const nextConfig: NextConfig = {
  basePath: normalizedBasePath || undefined,
};

export default nextConfig;
