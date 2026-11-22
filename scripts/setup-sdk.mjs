/**
 * Install the LearnHarness plugin API types into ./.sdk (type-only; never
 * bundled). Pass ONE of:
 *   - a LearnHarness checkout      (runs its scripts/build-plugin-types.mjs)
 *   - an extracted authoring skill (the learnharness-plugins/ folder)
 *   - the authoring skill zip      (Settings → Community plugins → Download authoring skill)
 *
 *   npm run sdk -- ../learnharness
 *   npm run sdk -- ~/Downloads/learnharness-plugins.zip
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".sdk");
const source = process.argv[2];
if (!source) {
  console.error(
    "Usage: npm run sdk -- <learnharness checkout | extracted authoring skill | authoring skill .zip>",
  );
  process.exit(1);
}
const input = path.resolve(
  source.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"),
);
if (!fs.existsSync(input)) throw new Error(`Not found: ${input}`);

const replaceOutput = () => {
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink())
    throw new Error("Refusing a symlinked .sdk");
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
};
const done = (how) => {
  if (!fs.existsSync(path.join(output, "index.d.ts")))
    throw new Error(`No index.d.ts was installed (${how}).`);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(output, "package.json"), "utf8"),
  );
  console.log(`[sdk] ${pkg.name}@${pkg.version} installed into .sdk (${how})`);
};

if (fs.statSync(input).isFile() && input.toLowerCase().endsWith(".zip")) {
  const { unzipSync } = await import("fflate");
  const files = unzipSync(fs.readFileSync(input));
  const marker = Object.keys(files).find((name) =>
    /(^|\/)types\/index\.d\.ts$/.test(name),
  );
  if (!marker)
    throw new Error(
      "This zip has no types/index.d.ts; is it the LearnHarness authoring skill?",
    );
  const prefix = marker.slice(0, -"index.d.ts".length);
  replaceOutput();
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.startsWith(prefix) || name.endsWith("/")) continue;
    const rel = name.slice(prefix.length);
    if (rel.split(/[\\/]/).includes("..") || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel))
      throw new Error(`Unsafe path in zip: ${name}`);
    const target = path.join(output, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  done("from authoring skill zip");
} else if (
  fs.existsSync(path.join(input, "scripts", "build-plugin-types.mjs"))
) {
  replaceOutput();
  const result = spawnSync(
    process.execPath,
    [path.join(input, "scripts", "build-plugin-types.mjs"), output],
    { cwd: input, stdio: "inherit" },
  );
  if (result.status !== 0)
    throw new Error(
      "The checkout's type build failed (run npm ci in the checkout first).",
    );
  done("built from LearnHarness checkout");
} else {
  const types = [
    path.join(input, "types"),
    path.join(input, "learnharness-plugins", "types"),
    input,
  ].find((dir) => fs.existsSync(path.join(dir, "index.d.ts")));
  if (!types)
    throw new Error(
      "No types/index.d.ts found; pass a LearnHarness checkout, the extracted authoring skill, or its zip.",
    );
  replaceOutput();
  fs.cpSync(types, output, { recursive: true });
  done("copied from extracted authoring skill");
}
