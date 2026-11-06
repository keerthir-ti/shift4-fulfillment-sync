/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Temporal client uses native gRPC code that must not be bundled. The workflow package is TypeScript source.
  serverExternalPackages: ["@temporalio/client"],
  transpilePackages: ["@shift4/order-delivery"],
};
export default nextConfig;
