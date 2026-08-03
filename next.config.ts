import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfmake는 CJS + 로컬 파일(폰트) 접근을 사용하므로 서버 번들링에서 제외
  serverExternalPackages: ["pdfmake"],
};

export default nextConfig;
