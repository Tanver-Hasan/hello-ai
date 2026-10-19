import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
	publicDir: false,
	plugins: [
		agents(),
		react(),
		cloudflare({ viteEnvironment: { name: "worker" } }),
	],
	environments: {
		worker: {
			build: {
				sourcemap: true,
			},
		},
	},
});
