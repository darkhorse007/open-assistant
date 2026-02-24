import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"

const gatewayTarget = process.env.VITE_GATEWAY_PROXY_TARGET ?? "http://127.0.0.1:7001"

export default defineConfig({
  plugins: [tailwindcss(), solidPlugin()],
  build: {
    assetsDir: "web-assets",
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        admin: fileURLToPath(new URL("./admin.html", import.meta.url)),
        "model-frame": fileURLToPath(new URL("./model-frame.html", import.meta.url)),
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    cors: true,
    proxy: {
      "/ws": { target: gatewayTarget, ws: true, changeOrigin: true },
      "/assets": { target: gatewayTarget, changeOrigin: true },
      "/admin/assets": { target: gatewayTarget, changeOrigin: true },
      "/healthz": { target: gatewayTarget, changeOrigin: true },
      "/readyz": { target: gatewayTarget, changeOrigin: true },
      "/mcp": { target: gatewayTarget, changeOrigin: true },
      "/metrics": { target: gatewayTarget, changeOrigin: true },
      "/audit": { target: gatewayTarget, changeOrigin: true },
      "/admin/api": { target: gatewayTarget, changeOrigin: true },
    },
  },
})
