// @ts-ignore — embedded at build time via esbuild text loader
import docsContent from "../skills/docs.txt";

export async function docsCommand(): Promise<number> {
  process.stdout.write(docsContent);
  process.stdout.write("\n");
  return 0;
}
