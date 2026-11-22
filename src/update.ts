/**
 * Self-update from signed GitHub releases. Nothing installs without an
 * explicit user action; every release is verified against the public key
 * built into the plugin, so access to the GitHub repo alone cannot ship code.
 *
 * Release assets (see scripts/release.mjs):
 *   latest.json      { id, version, minAppVersion, zip: { name, sha256, size }, notes, publishedAt }
 *   latest.json.sig  base64 Ed25519 signature over the exact latest.json bytes
 *   gamification-<version>.zip
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { UPDATE_PUBLIC_KEY } from "./update-key.ts";
import { extractZip } from "./zip.ts";

export const UPDATE_REPO = "All-Light/learnharness-gamification";
const FEED_BASE = `https://github.com/${UPDATE_REPO}/releases/latest/download/`;
const PLUGIN_ID = "gamification";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_FEED_BYTES = 64 * 1024;
const MAX_SIG_BYTES = 1024;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60_000;
const STATE_FILE = "update-state.json";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ReleaseInfo {
  version: string;
  minAppVersion: string;
  notes: string;
  publishedAt?: string;
  zip: { name: string; sha256: string; size: number };
}

export interface UpdateStatus {
  /** "updatable", or why self-update is turned off for this install. */
  mode: "updatable" | "developer" | "managed";
  current: string;
  latest?: ReleaseInfo;
  available: boolean;
  checkedAt?: string;
  error?: string;
  /** A previous version is kept and can be restored. */
  canRollBack: boolean;
  /** An update or rollback was applied; restart LearnHarness to load it. */
  restartRequired: boolean;
}

export function parseVersion(v: string): [number, number, number] | undefined {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** Verify a release feed's signature and shape. Throws on anything off. */
export function verifyFeed(
  feed: Buffer,
  signatureBase64: string,
  publicKey: string = UPDATE_PUBLIC_KEY,
): ReleaseInfo {
  if (!publicKey)
    throw new Error("This build has no update key; updates are disabled.");
  const key = crypto.createPublicKey({
    key: Buffer.from(publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  const signature = Buffer.from(signatureBase64.trim(), "base64");
  if (signature.length !== 64 || !crypto.verify(null, feed, key, signature))
    throw new Error("The update's signature is invalid. Not installing it.");
  let raw: any;
  try {
    raw = JSON.parse(feed.toString("utf8"));
  } catch {
    throw new Error("The update information is not valid JSON.");
  }
  const zip = raw?.zip;
  if (
    raw?.id !== PLUGIN_ID ||
    !parseVersion(String(raw?.version)) ||
    !parseVersion(String(raw?.minAppVersion)) ||
    typeof zip?.name !== "string" ||
    zip.name !== `${PLUGIN_ID}-${raw.version}.zip` ||
    typeof zip?.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(zip.sha256) ||
    !Number.isSafeInteger(zip?.size) ||
    zip.size <= 0 ||
    zip.size > MAX_ZIP_BYTES
  )
    throw new Error(
      "The update information is incomplete or for another plugin.",
    );
  return {
    version: raw.version,
    minAppVersion: raw.minAppVersion,
    notes: typeof raw.notes === "string" ? raw.notes.slice(0, 4000) : "",
    ...(typeof raw.publishedAt === "string"
      ? { publishedAt: raw.publishedAt }
      : {}),
    zip: { name: zip.name, sha256: zip.sha256, size: zip.size },
  };
}

/** GitHub release downloads redirect to githubusercontent.com storage. */
function allowedHost(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    (url.hostname === "github.com" ||
      url.hostname.endsWith(".githubusercontent.com"))
  );
}

async function fetchAsset(
  fetchImpl: FetchLike,
  name: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  let url = new URL(name, FEED_BASE);
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedHost(url))
      throw new Error(`Refused update download from ${url.hostname}.`);
    const response = await fetchImpl(url.href, {
      method: "GET",
      redirect: "manual",
      signal: combined,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location)
        throw new Error("Update download redirect without a location.");
      url = new URL(location, url);
      continue;
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      throw new Error("No published release was found.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Update download failed (${response.status}).`);
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Update download is larger than expected.");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Too many redirects while downloading the update.");
}

export interface UpdaterOptions {
  /** The installed plugin's code directory (ctx.directory). */
  directory: string;
  /** Writable plugin data directory (ctx.dataDirectory). */
  dataDirectory: string;
  currentVersion: string;
  fetchImpl?: FetchLike;
  publicKey?: string;
  now?: () => number;
}

export class Updater {
  private readonly root: string;
  private readonly fetchImpl: FetchLike;
  private restartRequired = false;
  private busy = false;

  constructor(private readonly options: UpdaterOptions) {
    this.root = path.dirname(options.directory);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private get publicKey() {
    return this.options.publicKey ?? UPDATE_PUBLIC_KEY;
  }

  /**
   * Self-update only manages a plain community install (<plugins>/gamification/dist).
   * A source checkout is updated with git; an app-bundled copy by the app.
   */
  async mode(): Promise<UpdateStatus["mode"]> {
    if (path.basename(this.options.directory) !== "dist") return "managed";
    for (const marker of ["package.json", ".git", "src"])
      if (await exists(path.join(this.root, marker))) return "developer";
    return "updatable";
  }

  private async readState(): Promise<{
    checkedAt?: string;
    latest?: ReleaseInfo;
    error?: string;
  }> {
    try {
      return JSON.parse(
        await fs.readFile(
          path.join(this.options.dataDirectory, STATE_FILE),
          "utf8",
        ),
      );
    } catch {
      return {};
    }
  }

  private async writeState(state: {
    checkedAt: string;
    latest?: ReleaseInfo;
    error?: string;
  }) {
    await fs.mkdir(this.options.dataDirectory, { recursive: true });
    await fs.writeFile(
      path.join(this.options.dataDirectory, STATE_FILE),
      JSON.stringify(state, null, 2),
      { mode: 0o600 },
    );
  }

  private async fetchRelease(signal?: AbortSignal): Promise<ReleaseInfo> {
    const feed = await fetchAsset(
      this.fetchImpl,
      "latest.json",
      MAX_FEED_BYTES,
      signal,
    );
    const sig = await fetchAsset(
      this.fetchImpl,
      "latest.json.sig",
      MAX_SIG_BYTES,
      signal,
    );
    return verifyFeed(feed, sig.toString("utf8"), this.publicKey);
  }

  /** Status, checking GitHub if `force` or the last check is over a day old. */
  async status(force = false, signal?: AbortSignal): Promise<UpdateStatus> {
    const mode = await this.mode();
    const current = this.options.currentVersion;
    const base = {
      mode,
      current,
      canRollBack:
        mode === "updatable" &&
        (await exists(path.join(this.root, "dist.previous", "manifest.json"))),
      restartRequired: this.restartRequired,
    };
    if (mode !== "updatable") return { ...base, available: false };
    let state = await this.readState();
    const now = (this.options.now ?? Date.now)();
    const stale =
      !state.checkedAt || now - Date.parse(state.checkedAt) > CHECK_INTERVAL_MS;
    if (force || stale) {
      try {
        const latest = await this.fetchRelease(signal);
        state = { checkedAt: new Date(now).toISOString(), latest };
      } catch (error) {
        state = {
          checkedAt: new Date(now).toISOString(),
          error: (error as Error).message,
        };
      }
      await this.writeState(state as { checkedAt: string });
    }
    const latest = state.latest;
    return {
      ...base,
      ...(latest ? { latest } : {}),
      ...(state.checkedAt ? { checkedAt: state.checkedAt } : {}),
      ...(state.error ? { error: state.error } : {}),
      available: !!latest && isNewer(latest.version, current),
    };
  }

  /** Download, verify and install the latest release. Restart to load it. */
  async install(signal?: AbortSignal): Promise<UpdateStatus> {
    if ((await this.mode()) !== "updatable")
      throw new Error("Updates for this install are managed elsewhere.");
    if (this.busy) throw new Error("An update is already in progress.");
    this.busy = true;
    const staging = path.join(this.root, `.update-${crypto.randomUUID()}`);
    try {
      // Re-fetch and re-verify; never trust the cached check for installing.
      const release = await this.fetchRelease(signal);
      if (!isNewer(release.version, this.options.currentVersion))
        throw new Error("No newer version is available.");
      const zip = await fetchAsset(
        this.fetchImpl,
        release.zip.name,
        release.zip.size,
        signal,
      );
      if (
        zip.length !== release.zip.size ||
        crypto.createHash("sha256").update(zip).digest("hex") !==
          release.zip.sha256
      )
        throw new Error(
          "The downloaded update does not match its signed checksum. Not installing it.",
        );
      const { files } = await extractZip(zip, staging);
      if (files.some((f) => !f.startsWith(`${PLUGIN_ID}/dist/`)))
        throw new Error("The update package has an unexpected layout.");
      const newDist = path.join(staging, PLUGIN_ID, "dist");
      const manifest = JSON.parse(
        await fs.readFile(path.join(newDist, "manifest.json"), "utf8"),
      );
      if (manifest?.id !== PLUGIN_ID || manifest?.version !== release.version)
        throw new Error(
          "The update package's manifest does not match the release.",
        );
      for (const entry of [manifest.main, manifest.backend, manifest.styles])
        if (entry && !(await exists(path.join(newDist, String(entry)))))
          throw new Error(`The update package is missing ${entry}.`);
      await this.swapIn(newDist);
      this.restartRequired = true;
      return this.status(false, signal);
    } finally {
      this.busy = false;
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Restore the previous version (kept as dist.previous). Restart to load it. */
  async rollBack(): Promise<UpdateStatus> {
    if ((await this.mode()) !== "updatable")
      throw new Error("Updates for this install are managed elsewhere.");
    const previous = path.join(this.root, "dist.previous");
    if (!(await exists(path.join(previous, "manifest.json"))))
      throw new Error("No previous version is available.");
    const aside = path.join(this.root, `.rollback-${crypto.randomUUID()}`);
    await fs.rename(previous, aside);
    await this.swapIn(aside);
    this.restartRequired = true;
    return this.status();
  }

  /** dist -> dist.previous, replacement -> dist; restores dist on failure. */
  private async swapIn(replacement: string) {
    const dist = path.join(this.root, "dist");
    const previous = path.join(this.root, "dist.previous");
    if (await exists(path.join(replacement, "data")))
      throw new Error("Refusing a package that contains data/.");
    await fs.rm(previous, { recursive: true, force: true });
    await fs.rename(dist, previous);
    try {
      await fs.rename(replacement, dist);
    } catch (error) {
      await fs.rename(previous, dist).catch(() => {});
      throw error;
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
