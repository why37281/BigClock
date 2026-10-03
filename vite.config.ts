import { defineConfig, type Plugin } from "vite";

/**
 * 去掉 Vite 注入的 crossorigin 属性。
 *
 * 为什么需要：Vite 默认给 <script type="module"> 和 <link rel="stylesheet">
 * 加上 crossorigin。而 Tauri 打包后是用自定义协议（Windows 上是
 * http://tauri.localhost）提供资源的，带 crossorigin 的请求在某些 WebView2
 * 版本上会被当作跨域请求处理，结果是【脚本静默不执行、页面也不报错】——
 * 表现就是"窗口一片空白/什么都不动"。这些资源本来就同源，这个属性没有任何用处。
 */
function stripCrossorigin(): Plugin {
  return {
    name: "bigclock-strip-crossorigin",
    enforce: "post",
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(=["'][^"']*["'])?/g, "");
    },
  };
}

export default defineConfig({
  base: "./",
  clearScreen: false,
  plugins: [stripCrossorigin()],
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
    // 不生成 modulepreload 的 polyfill：它同样是给普通网站用的，
    // 在自定义协议下只会多引入一个需要加载的文件。
    modulePreload: { polyfill: false },
  },
});
