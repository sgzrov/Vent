import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/index.mjs",
  banner: {
    js: "#!/usr/bin/env node",
  },
});

console.log("Bundled → dist/index.mjs");
