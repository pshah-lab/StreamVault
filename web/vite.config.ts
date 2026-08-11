import { defineConfig } from "vite";

export default defineConfig({
  base: "/app/",
  server: {
    proxy: {
      "/output": {
        target: "https://***REMOVED***.cloudfront.net",
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
