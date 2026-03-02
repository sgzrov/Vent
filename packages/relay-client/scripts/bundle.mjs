import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/relay-client.mjs",
  banner: {
    js: "#!/usr/bin/env node",
  },
});

console.log("Bundled → dist/relay-client.mjs");
