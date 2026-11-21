import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The components are JSX in .js files (from Create React App), so tell Vite to read them as JSX.
export default defineConfig({
  plugins: [react({ include: /\.(js|jsx)$/ })],
  esbuild: { loader: "jsx", include: /src\/.*\.jsx?$/, exclude: [] },
  optimizeDeps: { esbuildOptions: { loader: { ".js": "jsx" } } },
  // Same output folder as before, which the Dockerfile copies into the Caddy image
  build: { outDir: "build", chunkSizeWarningLimit: 1000 },
});
