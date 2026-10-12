import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  if (command === "build" && !env.VITE_API_URL?.trim()) {
    throw new Error("VITE_API_URL is required for a production build");
  }
  if (command === "build") {
    const value = env.VITE_API_URL.trim().replace(/\/+$/, "");
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("VITE_API_URL must be the public HTTP(S) backend origin");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      value !== url.origin ||
      ["backend", "frontend", "mongodb"].includes(url.hostname)
    ) {
      throw new Error(
        "VITE_API_URL must be browser-visible, without /api or a Docker service hostname",
      );
    }
  }
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
    },
  };
});
