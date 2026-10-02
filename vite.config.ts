import { defineConfig } from "vite";

// Tauri 用自定义协议从二进制里提供资源，必须用相对路径，否则资源 404。
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120",
    assetsInlineLimit: 0, // 字体不要内联成 base64，保持可缓存
    sourcemap: false,
  },
});
