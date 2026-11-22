import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
try {
  if (fs.lstatSync(output).isSymbolicLink())
    throw new Error("Refusing to build into a symlinked dist directory.");
  try {
    fs.lstatSync(path.join(output, "data"));
    throw new Error(
      "Refusing to build over dist/data; preserve plugin data outside dist first.",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const common = {
  absWorkingDir: root,
  bundle: true,
  target: "es2022",
  minify: true,
  legalComments: "eof",
  metafile: true,
  logLevel: "warning",
};
const frontend = await build({
  ...common,
  entryPoints: ["src/main.ts"],
  outfile: path.join(output, "main.js"),
  format: "esm",
  platform: "browser",
});
const backend = await build({
  ...common,
  entryPoints: ["src/backend.ts"],
  outfile: path.join(output, "backend.cjs"),
  format: "cjs",
  platform: "node",
  target: "node22",
});
for (const result of [frontend, backend])
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.startsWith("src/") && !input.startsWith("node_modules/"))
      throw new Error(`Unexpected runtime input: ${input}`);
  }
fs.copyFileSync(
  path.join(root, "manifest.json"),
  path.join(output, "manifest.json"),
);
fs.copyFileSync(path.join(root, "README.md"), path.join(output, "README.md"));
fs.copyFileSync(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
fs.copyFileSync(
  path.join(root, "src/styles.css"),
  path.join(output, "styles.css"),
);
console.log(`Built Gamification plugin: ${output}`);
