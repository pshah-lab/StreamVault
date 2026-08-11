import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    base: "/app/",
    server: {
      proxy: {
        "/output": {
          target: env.VITE_PROXY_TARGET || "https://localhost",
          changeOrigin: true,
          secure: true,
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
