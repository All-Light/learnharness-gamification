/**
 * Package dist/ for a GitHub Release. Run via `npm run release` (typecheck,
 * test and build first). Produces in release/:
 *   gamification-<version>.zip   extract into the plugins folder (gamification/dist/...)
 *   latest.json                version, minimum app version, zip checksum, notes
 *   latest.json.sig            Ed25519 signature over latest.json
 * Upload all three to the release. Options:
 *   --notes "text"   release notes shown in the update prompt
 *   --unsigned       only build the zip (local testing; not installable as an update)
 * The signing key is read from GAMIFICATION_PLUGIN_SIGNING_KEY or
 * ~/.config/learnharness-gamification/signing-key.pem (create it with npm run keygen).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
const args = process.argv.slice(2);
const unsigned = args.includes("--unsigned");
const notesIndex = args.indexOf("--notes");
const notes = notesIndex >= 0 ? (args[notesIndex + 1] ?? "") : "";

const manifest = JSON.parse(
  fs.readFileSync(path.join(dist, "manifest.json"), "utf8"),
);
if (fs.existsSync(path.join(dist, "dev-build.json")))
  throw new Error("dist/ is a development build; run npm run release (it rebuilds) instead");
if (fs.existsSync(path.join(dist, "data")))
  throw new Error("Refusing to package dist/data");

const entries = {};
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Refusing symlink in dist: ${full}`);
    if (entry.isDirectory()) walk(full);
    else
      entries[
        `${manifest.id}/dist/${path.relative(dist, full).split(path.sep).join("/")}`
      ] = fs.readFileSync(full);
  }
};
walk(dist);
const outDir = path.join(root, "release");
fs.mkdirSync(outDir, { recursive: true });
const zipName = `${manifest.id}-${manifest.version}.zip`;
const zip = Buffer.from(zipSync(entries, { level: 9 }));
fs.writeFileSync(path.join(outDir, zipName), zip);
console.log(
  `[release] release/${zipName} (${Object.keys(entries).length} files, ${(zip.length / 1024).toFixed(0)} KB)`,
);
if (unsigned) process.exit(0);

const keyPath =
  process.env.GAMIFICATION_PLUGIN_SIGNING_KEY ??
  path.join(
    os.homedir(),
    ".config",
    "learnharness-gamification",
    "signing-key.pem",
  );
if (!fs.existsSync(keyPath)) {
  console.error(
    `[release] No signing key at ${keyPath}. Run npm run keygen once, or pass --unsigned for a local zip only.`,
  );
  process.exit(1);
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
// The key must match the public key built into this release, or installed
// copies would reject it.
const built = /UPDATE_PUBLIC_KEY = "([^"]*)"/.exec(
  fs.readFileSync(path.join(root, "src", "update-key.ts"), "utf8"),
)?.[1];
const derived = crypto
  .createPublicKey(privateKey)
  .export({ type: "spki", format: "der" })
  .toString("base64");
if (built !== derived) {
  console.error(
    "[release] The signing key does not match src/update-key.ts; refusing to sign.",
  );
  process.exit(1);
}
const feed = Buffer.from(
  JSON.stringify(
    {
      id: manifest.id,
      version: manifest.version,
      minAppVersion: manifest.minAppVersion,
      zip: {
        name: zipName,
        sha256: crypto.createHash("sha256").update(zip).digest("hex"),
        size: zip.length,
      },
      notes,
      publishedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
fs.writeFileSync(path.join(outDir, "latest.json"), feed);
fs.writeFileSync(
  path.join(outDir, "latest.json.sig"),
  crypto.sign(null, feed, privateKey).toString("base64") + "\n",
);
console.log("[release] release/latest.json + latest.json.sig (signed)");
