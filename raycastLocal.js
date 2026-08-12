import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const RAYCAST_SALT = "yvkwWXzxPPBAqY2tmaKrB*DvYjjMaeEf";
const RAYCAST_SUPPORT = join(homedir(), "Library", "Application Support", "com.raycast.macos");
const RAYCAST_DB = join(RAYCAST_SUPPORT, "raycast-enc.sqlite");
const POSTHOG_DISTINCT = join(RAYCAST_SUPPORT, "posthog.distinctId");

function readKeychainJson(account) {
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Raycast", "-a", account, "-w"],
      { encoding: "utf-8" }
    ).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getDatabasePassphrase() {
  const keyHex = execFileSync(
    "security",
    ["find-generic-password", "-s", "Raycast", "-a", "database_key", "-w"],
    { encoding: "utf-8" }
  ).trim();
  return createHash("sha256").update(keyHex + RAYCAST_SALT).digest("hex");
}

function queryEncryptedDb(passphrase, sql) {
  if (!existsSync(RAYCAST_DB)) return [];

  const tmpDir = mkdtempSync(join(tmpdir(), "omniroute-raycast-"));
  const tmpDb = join(tmpDir, "raycast-enc.sqlite");

  const cleanup = () => {
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(tmpDb + ext);
      } catch {
        // ignore
      }
    }
    try {
      rmdirSync(tmpDir);
    } catch {
      // ignore
    }
  };

  try {
    copyFileSync(RAYCAST_DB, tmpDb);
    for (const ext of ["-wal", "-shm"]) {
      const src = RAYCAST_DB + ext;
      if (existsSync(src)) copyFileSync(src, tmpDb + ext);
    }

    const input = `PRAGMA key = '${passphrase}';\n.mode json\n${sql}`;
    const result = execFileSync("sqlcipher", [tmpDb], { input, encoding: "utf-8" });
    const jsonStr = result.startsWith("ok\n") ? result.slice(3) : result;
    return JSON.parse(jsonStr.trim() || "[]");
  } catch {
    return [];
  } finally {
    cleanup();
  }
}

function readAnalyticsIdFromDb() {
  try {
    const passphrase = getDatabasePassphrase();
    const rows = queryEncryptedDb(
      passphrase,
      "SELECT analyticsId FROM user WHERE analyticsId IS NOT NULL LIMIT 1;"
    );
    return rows[0]?.analyticsId?.trim() || null;
  } catch {
    return null;
  }
}

function readAnalyticsIdFromPosthog() {
  try {
    if (!existsSync(POSTHOG_DISTINCT)) return null;
    const parsed = JSON.parse(readFileSync(POSTHOG_DISTINCT, "utf-8"));
    return parsed["posthog.distinctId"]?.trim() || null;
  } catch {
    return null;
  }
}

function readUserProfile() {
  try {
    const passphrase = getDatabasePassphrase();
    const rows = queryEncryptedDb(
      passphrase,
      "SELECT email, username, hasProFeatures, hasBetterAI FROM user LIMIT 1;"
    );
    const row = rows[0];
    if (!row) return {};
    return {
      email: row.email,
      username: row.username,
      hasProFeatures: !!row.hasProFeatures,
      hasBetterAI: !!row.hasBetterAI,
    };
  } catch {
    return {};
  }
}

export function isRaycastLocalExtractAvailable() {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("which", ["sqlcipher"], { encoding: "utf-8" });
  } catch {
    return false;
  }
  return existsSync(RAYCAST_DB) || existsSync(POSTHOG_DISTINCT);
}

export function extractLocalRaycastCredentials() {
  if (process.platform !== "darwin") {
    throw new Error("Raycast auto-import is macOS-only");
  }

  const store = readKeychainJson("raycast-store_credentials");
  const oauth = store?.oauth || {};
  const accessToken = oauth.access_token?.trim();
  if (!accessToken) {
    throw new Error("Raycast bearer token not found in Keychain — open Raycast and sign in first");
  }

  const analyticsFromDb = readAnalyticsIdFromDb();
  const analyticsFromPosthog = readAnalyticsIdFromPosthog();
  const deviceId = analyticsFromDb || analyticsFromPosthog;
  if (!deviceId) {
    throw new Error(
      "Raycast device/analytics ID not found — launch Raycast once so it writes local state"
    );
  }

  const profile = readUserProfile();
  const user = store?.user || {};

  return {
    accessToken,
    deviceId,
    aid: deviceId,
    email: profile.email || user.email,
    username: profile.username || user.username,
    hasProFeatures: profile.hasProFeatures,
    hasBetterAI: profile.hasBetterAI,
    source: analyticsFromDb ? "keychain+analyticsId" : "keychain+posthog",
  };
}