import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import {
  extractLocalRaycastCredentials,
  isRaycastLocalExtractAvailable,
} from "@/lib/oauth/services/raycastLocal";
import {
  resolveRaycastSecrets,
  fetchRaycastModels,
  probeRaycastChat,
} from "open-sse/services/raycast.js";

/**
 * GET /api/oauth/raycast/auto-import
 * Report whether local macOS auto-extraction is available.
 */
export async function GET() {
  return NextResponse.json({
    available: isRaycastLocalExtractAvailable(),
    platform: process.platform,
    requires: ["macOS", "Raycast.app installed", "sqlcipher CLI (brew install sqlcipher)"],
    sources: {
      bearerToken: "Keychain → Raycast / raycast-store_credentials → oauth.access_token",
      deviceId: "Raycast encrypted DB user.analyticsId (or posthog.distinctId on disk)",
    },
  });
}

/**
 * POST /api/oauth/raycast/auto-import
 * One-click local macOS Raycast credential extraction + validation + persistence.
 */
export async function POST() {
  if (!isRaycastLocalExtractAvailable()) {
    return NextResponse.json(
      {
        error:
          "Raycast auto-import unavailable — need macOS, Raycast installed, and sqlcipher (`brew install sqlcipher`)",
      },
      { status: 400 }
    );
  }

  try {
    const local = extractLocalRaycastCredentials();
    const providerSpecificData = {
      deviceId: local.deviceId,
      aid: local.aid,
      authMethod: "auto_imported",
      ...(local.username ? { username: local.username } : {}),
      ...(local.hasProFeatures !== undefined ? { hasProFeatures: local.hasProFeatures } : {}),
      ...(local.hasBetterAI !== undefined ? { hasBetterAI: local.hasBetterAI } : {}),
      extractSource: local.source,
    };

    const creds = { accessToken: local.accessToken, providerSpecificData };
    try {
      resolveRaycastSecrets(creds);
    } catch (err) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    // Real auth check — reject an invalid/cookie token before persisting.
    const probe = await probeRaycastChat(creds);
    if (!probe.ok) {
      return NextResponse.json(
        { error: `Raycast auto-import validation failed: ${probe.error}` },
        { status: Number(probe.status) || 401 }
      );
    }

    let models = [];
    let modelCount = 0;
    let premiumModelCount = 0;
    try {
      models = await fetchRaycastModels(creds);
      modelCount = models.length;
      premiumModelCount = models.filter((m) => m.requires_better_ai).length;
    } catch {
      // informational only
    }
    providerSpecificData.modelCount = modelCount;
    providerSpecificData.premiumModelCount = premiumModelCount;

    const connection = await createProviderConnection({
      provider: "raycast",
      authType: "oauth",
      accessToken: local.accessToken,
      refreshToken: null,
      email: local.email || null,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      providerSpecificData,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      source: local.source,
      connection: {
        id: connection.id,
        provider: "raycast",
        email: connection.email,
      },
      models: {
        total: modelCount,
        premium: premiumModelCount,
        sample: models.slice(0, 12).map((m) => m.id),
      },
    });
  } catch (error) {
    console.log("Raycast auto-import error:", error);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}