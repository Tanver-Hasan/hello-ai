import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	publicDir: false,
	plugins: [react(), cloudflare({ viteEnvironment: { name: "worker" } })],
	environments: {
		worker: {
			build: {
				sourcemap: true,
			},
		},
	},
});
