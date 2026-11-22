import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { isNewer, Updater, UPDATE_REPO, verifyFeed, type FetchLike } from "../src/update.ts";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUBLIC = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const OTHER = crypto.generateKeyPairSync("ed25519");

function pluginZip(version: string, extra: Record<string, Uint8Array> = {}, manifestVersion = version) {
  const manifest = { apiVersion: 1, id: "gamification", name: "Gamification", version: manifestVersion, minAppVersion: "0.7.0", main: "main.js", backend: "backend.cjs" };
  return Buffer.from(zipSync({
    "gamification/dist/manifest.json": strToU8(JSON.stringify(manifest)),
    "gamification/dist/main.js": strToU8(`// ${version}`),
    "gamification/dist/backend.cjs": strToU8(`// ${version}`),
    ...extra,
  }));
}

function release(version: string, zip: Buffer, key = privateKey, overrides: Record<string, unknown> = {}) {
  const feed = Buffer.from(JSON.stringify({
    id: "gamification", version, minAppVersion: "0.7.0",
    zip: { name: `gamification-${version}.zip`, sha256: crypto.createHash("sha256").update(zip).digest("hex"), size: zip.length },
    notes: "Fixes.", ...overrides,
  }));
  return { feed, sig: crypto.sign(null, feed, key).toString("base64"), zip };
}

/** Fake GitHub: latest/download redirects to githubusercontent storage. */
function github(assets: Record<string, Buffer | string>, log: string[] = []): FetchLike {
  return async (url) => {
    log.push(url);
    const u = new URL(url);
    const prefix = `/${UPDATE_REPO}/releases/latest/download/`;
    if (u.hostname === "github.com" && u.pathname.startsWith(prefix))
      return new Response(null, { status: 302, headers: { location: `https://objects.githubusercontent.com/r/${u.pathname.slice(prefix.length)}` } });
    if (u.hostname === "objects.githubusercontent.com") {
      const body = assets[u.pathname.slice(3)];
      return body === undefined ? new Response("", { status: 404 }) : new Response(typeof body === "string" ? body : new Uint8Array(body));
    }
    return new Response("", { status: 404 });
  };
}

async function install(t: { after: (fn: () => Promise<void>) => void }, version = "0.2.0") {
  const plugins = await fs.mkdtemp(path.join(os.tmpdir(), "gamification-update-"));
  t.after(() => fs.rm(plugins, { recursive: true, force: true }));
  const root = path.join(plugins, "gamification");
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "manifest.json"), JSON.stringify({ id: "gamification", version }));
  await fs.writeFile(path.join(root, "data", "state.json"), "secret");
  return root;
}

const updater = (root: string, fetchImpl: FetchLike, now = () => Date.now(), currentVersion = "0.2.0") =>
  new Updater({ directory: path.join(root, "dist"), dataDirectory: path.join(root, "data"), currentVersion, currentMinAppVersion: "0.7.0", fetchImpl, publicKey: PUBLIC, now });

test("version comparison", () => {
  assert.equal(isNewer("0.3.0", "0.2.0"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("0.2.0", "0.2.0"), false);
  assert.equal(isNewer("0.1.9", "0.2.0"), false);
  assert.equal(isNewer("1.0", "0.2.0"), false);
});

test("feed signature: valid, tampered, wrong key, wrong plugin", () => {
  const r = release("0.3.0", pluginZip("0.3.0"));
  assert.equal(verifyFeed(r.feed, r.sig, PUBLIC).version, "0.3.0");
  const tampered = Buffer.from(r.feed.toString().replace("0.3.0", "0.3.1"));
  assert.throws(() => verifyFeed(tampered, r.sig, PUBLIC), /signature is invalid/);
  const other = release("0.3.0", pluginZip("0.3.0"), OTHER.privateKey);
  assert.throws(() => verifyFeed(other.feed, other.sig, PUBLIC), /signature is invalid/);
  const wrong = release("0.3.0", pluginZip("0.3.0"), privateKey, { id: "other-plugin" });
  assert.throws(() => verifyFeed(wrong.feed, wrong.sig, PUBLIC), /another plugin/);
  const badName = release("0.3.0", pluginZip("0.3.0"), privateKey, { zip: { name: "../evil.zip", sha256: "0".repeat(64), size: 10 } });
  assert.throws(() => verifyFeed(badName.feed, badName.sig, PUBLIC), /incomplete/);
  assert.throws(() => verifyFeed(r.feed, r.sig, ""), /no update key/);
});

test("check: finds a newer release and caches the check for a day", async (t) => {
  const root = await install(t);
  const r = release("0.3.0", pluginZip("0.3.0"));
  const log: string[] = [];
  let now = Date.parse("2026-11-22T10:00:00Z");
  const u = updater(root, github({ "latest.json": r.feed, "latest.json.sig": r.sig }, log), () => now);
  const first = await u.status();
  assert.equal(first.available, true);
  assert.equal(first.latest?.version, "0.3.0");
  const fetched = log.length;
  await u.status();
  assert.equal(log.length, fetched, "second check within a day used the cache");
  now += 25 * 60 * 60 * 1000;
  await u.status();
  assert.ok(log.length > fetched, "checked again after a day");
  const forced = log.length;
  await u.status(true);
  assert.ok(log.length > forced, "manual check always fetches");
});

test("install: verified update replaces dist, keeps data, allows rollback", async (t) => {
  const root = await install(t);
  const r = release("0.3.0", pluginZip("0.3.0"));
  const u = updater(root, github({ "latest.json": r.feed, "latest.json.sig": r.sig, "gamification-0.3.0.zip": r.zip }));
  const status = await u.install();
  assert.equal(status.restartRequired, true);
  assert.equal(status.canRollBack, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "dist", "manifest.json"), "utf8")).version, "0.3.0");
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "dist.previous", "manifest.json"), "utf8")).version, "0.2.0");
  assert.equal(await fs.readFile(path.join(root, "data", "state.json"), "utf8"), "secret");
  assert.deepEqual((await fs.readdir(root)).sort(), ["data", "dist", "dist.previous"], "no staging leftovers");
  // Nothing more can change until LearnHarness restarts (even with a new Updater).
  await assert.rejects(u.rollBack(), /Restart LearnHarness/);
  await assert.rejects(updater(root, github({})).install(), /Restart LearnHarness/);
  assert.equal((await updater(root, github({})).status()).restartRequired, true);
  // After the restart, 0.3.0 is running and can be rolled back.
  const restarted = updater(root, github({ "latest.json": r.feed, "latest.json.sig": r.sig }), undefined, "0.3.0");
  assert.equal((await restarted.status()).restartRequired, false);
  await restarted.rollBack();
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "dist", "manifest.json"), "utf8")).version, "0.2.0");
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "dist.previous", "manifest.json"), "utf8")).version, "0.3.0");
});

test("install refuses bad releases and leaves the current version in place", async (t) => {
  const cases: [string, () => Record<string, Buffer | string>, RegExp][] = [
    ["checksum mismatch", () => { const r = release("0.3.0", pluginZip("0.3.0")); return { "latest.json": r.feed, "latest.json.sig": r.sig, "gamification-0.3.0.zip": pluginZip("0.3.0", { "gamification/dist/x.js": strToU8("evil") }) }; }, /checksum|larger than expected/],
    ["same-size tamper", () => { const r = release("0.3.0", pluginZip("0.3.0")); const bad = Buffer.from(r.zip); bad[bad.length - 30] = (bad[bad.length - 30] ?? 0) ^ 0xff; return { "latest.json": r.feed, "latest.json.sig": r.sig, "gamification-0.3.0.zip": bad }; }, /checksum/],
    ["same version", () => { const r = release("0.2.0", pluginZip("0.2.0")); return { "latest.json": r.feed, "latest.json.sig": r.sig, "gamification-0.2.0.zip": r.zip }; }, /No newer version/],
    ["older version", () => { const r = release("0.1.0", pluginZip("0.1.0")); return { "latest.json": r.feed, "latest.json.sig": r.sig, "gamification-0.1.0.zip": r.zip }; }, /No newer version/],
    ["unsigned feed", () => { const r = release("0.3.0", pluginZip("0.3.0"), OTHER.privateKey); return { "latest.json": r.feed, "latest.json.sig": r.sig, "gamification-0.3.0.zip": r.zip }; }, /signature/],
    ["files outside dist", () => { const zip = pluginZip("0.3.0", { "gamification/data/state.json": strToU8("stolen") }); const r = release("0.3.0", zip); return { "latest.json": r.feed, "latest.json.sig": r.sig, "gamification-0.3.0.zip": zip }; }, /unexpected layout/],
    ["manifest mismatch", () => { const zip = pluginZip("0.3.0", {}, "9.9.9"); const r = release("0.3.0", zip); return { "latest.json": r.feed, "latest.json.sig": r.sig, "gamification-0.3.0.zip": zip }; }, /manifest does not match/],
    ["no release", () => ({}), /No published release/],
  ];
  for (const [name, assets, error] of cases) {
    const root = await install(t);
    await assert.rejects(updater(root, github(assets())).install(), error, name);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, "dist", "manifest.json"), "utf8")).version, "0.2.0", name);
    assert.equal(await fs.readFile(path.join(root, "data", "state.json"), "utf8"), "secret", name);
    assert.deepEqual((await fs.readdir(root)).sort(), ["data", "dist"], `${name}: no leftovers`);
  }
});

test("downloads only from GitHub over https", async (t) => {
  const root = await install(t);
  const evil: FetchLike = async () => new Response(null, { status: 302, headers: { location: "https://evil.example/latest.json" } });
  const status = await updater(root, evil).status(true);
  assert.match(status.error ?? "", /Refused update download from evil\.example/);
  assert.equal(status.available, false);
});

test("developer and app-managed installs never self-update", async (t) => {
  const root = await install(t);
  await fs.writeFile(path.join(root, "package.json"), "{}");
  const log: string[] = [];
  const dev = updater(root, github({}, log));
  assert.equal((await dev.status(true)).mode, "developer");
  await assert.rejects(dev.install(), /managed elsewhere/);
  assert.equal(log.length, 0, "developer installs never contact GitHub");
  const managed = new Updater({ directory: root, dataDirectory: path.join(root, "data"), currentVersion: "0.2.0", fetchImpl: github({}), publicKey: PUBLIC });
  assert.equal((await managed.status()).mode, "managed");
});

test("a release needing a newer LearnHarness requires confirmation", async (t) => {
  const zip = pluginZip("0.3.0");
  // The manifest inside must match the release's minAppVersion.
  const files = await import("fflate").then(({ unzipSync, zipSync }) => {
    const entries = unzipSync(new Uint8Array(zip));
    const m = JSON.parse(new TextDecoder().decode(entries["gamification/dist/manifest.json"]));
    m.minAppVersion = "0.9.0";
    entries["gamification/dist/manifest.json"] = strToU8(JSON.stringify(m));
    return Buffer.from(zipSync(entries));
  });
  const r = release("0.3.0", files, privateKey, { minAppVersion: "0.9.0" });
  const assets = { "latest.json": r.feed, "latest.json.sig": r.sig, "gamification-0.3.0.zip": r.zip };
  const root = await install(t);
  const status = await updater(root, github(assets)).status(true);
  assert.equal(status.needsAppConfirm, true);
  await assert.rejects(updater(root, github(assets)).install(), /needs LearnHarness 0\.9\.0/);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "dist", "manifest.json"), "utf8")).version, "0.2.0");
  await updater(root, github(assets)).install(undefined, { confirmAppVersion: true });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "dist", "manifest.json"), "utf8")).version, "0.3.0");
  // A release with the same minimum needs no confirmation.
  const same = release("0.3.0", pluginZip("0.3.0"));
  const root2 = await install(t);
  assert.equal((await updater(root2, github({ "latest.json": same.feed, "latest.json.sig": same.sig })).status(true)).needsAppConfirm, undefined);
});

test("install and rollback share one lock; the known-good version is never lost", async (t) => {
  const root = await install(t);
  await fs.mkdir(path.join(root, "dist.previous"));
  await fs.writeFile(path.join(root, "dist.previous", "manifest.json"), JSON.stringify({ id: "gamification", version: "0.1.0" }));
  const r = release("0.3.0", pluginZip("0.3.0"));
  const u = updater(root, github({ "latest.json": r.feed, "latest.json.sig": r.sig, "gamification-0.3.0.zip": r.zip }));
  const results = await Promise.allSettled([u.install(), u.rollBack()]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1, "exactly one of them runs");
  const versions = await Promise.all(["dist", "dist.previous"].map(async (d) => JSON.parse(await fs.readFile(path.join(root, d, "manifest.json"), "utf8")).version));
  assert.ok(versions.includes("0.2.0"), `0.2.0 must survive, got ${versions}`);
});

test("development builds and unsafe packages are never installed", async (t) => {
  const root = await install(t);
  await fs.writeFile(path.join(root, "dist", "dev-build.json"), "{}");
  const log: string[] = [];
  assert.equal((await updater(root, github({}, log)).status(true)).mode, "developer");
  assert.equal(log.length, 0);
  for (const [name, extra, error] of [
    ["dev build inside", { "gamification/dist/dev-build.json": strToU8("{}") }, /development build/],
    ["entry that cannot be unpacked safely", { "../outside.txt": strToU8("x") }, /could not be unpacked safely/],
  ] as const) {
    const zip = pluginZip("0.3.0", extra as Record<string, Uint8Array>);
    const r = release("0.3.0", zip);
    const target = await install(t);
    await assert.rejects(updater(target, github({ "latest.json": r.feed, "latest.json.sig": r.sig, "gamification-0.3.0.zip": zip })).install(), error, name);
    assert.equal(JSON.parse(await fs.readFile(path.join(target, "dist", "manifest.json"), "utf8")).version, "0.2.0", name);
  }
});

test("a failed check does not delay the next one; crash leftovers are cleaned", async (t) => {
  const root = await install(t);
  await fs.mkdir(path.join(root, ".update-0b6c2f0e-8f7a-4d35-9a8e-1c2d3e4f5a6b"));
  const log: string[] = [];
  const u = updater(root, github({}, log));
  const first = await u.status();
  assert.match(first.error ?? "", /No published release/);
  assert.equal(first.checkedAt, undefined);
  const before = log.length;
  await u.status();
  assert.ok(log.length > before, "retried without force");
  assert.deepEqual((await fs.readdir(root)).sort(), ["data", "dist"]);
});
