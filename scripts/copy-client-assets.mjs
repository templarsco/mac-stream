import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "src", "client", "index.html");
const dest = join(root, "dist", "client", "index.html");

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);

console.log("Copied index.html → dist/client/index.html");
