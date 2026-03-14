import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: ["src/client/main.ts"],
		format: "cjs",
		outDir: "dist/client",
		external: ["electron"],
		noExternal: ["ws"],
		clean: false,
	},
	{
		entry: ["src/client/preload.ts"],
		format: "cjs",
		outDir: "dist/client",
		external: ["electron"],
		clean: false,
	},
	{
		entry: ["src/client/renderer.ts"],
		format: "iife",
		outDir: "dist/client",
		clean: false,
	},
]);
