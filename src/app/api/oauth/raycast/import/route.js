import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import {
  resolveRaycastSecrets,
  decodeAidFromRaycastJwt,
  fetchRaycastModels,
  probeRaycastChat,
} from "open-sse/services/raycast.js";

/**
 * POST /api/oauth/raycast/import
 * Import and validate a Raycast Pro bearer token (+ deviceId + optional sig secret/JWT).
 *
 * Validation: besides listing models (which succeeds even for a garbage token), a
 * real one-turn chat probe is issued so that cookie-style / unsigned-in tokens are
 * rejected and never persisted as an active connection.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = String(body.accessToken || "").trim();
    const deviceId = String(body.deviceId || "").trim();
    const sigSecret = String(body.sigSecret || body.sidSecret || "").trim();
    const aidHint = String(body.aid || "").trim();
    const signatureJwt = String(body.signatureJwt || body.sidSecret || "").trim();

    if (!accessToken) {
      return NextResponse.json({ error: "Access token is required" }, { status: 400 });
    }
    if (!deviceId) {
      return NextResponse.json({ error: "Device ID (X-Raycast-DeviceId) is required" }, { status: 400 });
    }

    // Reject cookie-style captures (e.g. "csrf_token=...;") so a bogus import
    // surfaces immediately instead of silently becoming an "active" connection.
    const isJwt = /^[A-Za-z0-9\-_.]+\.[A-Za-z0-9\-_.]+\.[A-Za-z0-9\-_.]+$/.test(accessToken);
    const cookieStyle = /^[a-zA-Z0-9_+.\-]+=/.test(accessToken);
    if (cookieStyle && !accessToken.startsWith("rca_") && !isJwt) {
      return NextResponse.json(
        {
          error:
            "That looks like a cookie, not an OAuth bearer token. Capture the Authorization: Bearer <rca_...> value from backend.raycast.com during a Raycast chat — do not paste the csrf_token cookie.",
        },
        { status: 400 }
      );
    }

    // Resolve the account ID: explicit hint, then the signature JWT payload, then deviceId.
    const aid = aidHint || decodeAidFromRaycastJwt(signatureJwt) || deviceId;

    const providerSpecificData = {
      deviceId,
      aid,
      ...(sigSecret ? { sigSecret } : {}),
      authMethod: "imported",
    };

    // Shape validation (throws if required fields missing).
    const creds = { accessToken, providerSpecificData };
    try {
      resolveRaycastSecrets(creds);
    } catch (err) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    // Real auth gate — the chat probe is what actually validates the token.
    let probe;
    try {
      probe = await probeRaycastChat(creds);
    } catch (err) {
      return NextResponse.json({ error: `Raycast probe failed: ${err.message}` }, { status: 502 });
    }
    if (!probe.ok) {
      return NextResponse.json(
        { error: `Raycast validation failed: ${probe.error}` },
        { status: Number(probe.status) || 401 }
      );
    }

    // Connectivity + premium model counts.
    let models = [];
    let modelCount = 0;
    let premiumModelCount = 0;
    try {
      models = await fetchRaycastModels(creds);
      modelCount = models.length;
      premiumModelCount = models.filter((m) => m.requires_better_ai).length;
    } catch {
      // probe already succeeded; counts are informational only.
    }

    const connection = await createProviderConnection({
      provider: "raycast",
      authType: "oauth",
      accessToken,
      refreshToken: null,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      providerSpecificData: {
        deviceId,
        aid,
        ...(sigSecret ? { sigSecret } : {}),
        authMethod: "imported",
        modelCount,
        premiumModelCount,
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: { id: connection.id, provider: "raycast" },
      models: {
        total: modelCount,
        premium: premiumModelCount,
        sample: models.slice(0, 8).map((m) => m.id),
      },
    });
  } catch (error) {
    console.log("Raycast import token error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

function resolveAid(hint, signatureJwt, deviceId) {
  return (hint || "").trim() || decodeAidFromRaycastJwt(signatureJwt) || deviceId;
}

function resolveAid(hint, signatureJwt, deviceId) {
  return (hint || "").trim() || decodeAidFromRaycastJwt(signatureJwt) || deviceId;
}

/**
 * GET /api/oauth/raycast/import
 * Instructions for required Raycast fields.
 */
export async function GET() {
  return NextResponse.json({
    provider: "raycast",
    method: "import_token",
    instructions: [
      "Easiest: click Auto-Import (macOS) — reads Keychain + local Raycast DB.",
      "Manual fallback: Proxyman/Charles SSL proxy on backend.raycast.com.",
      "Bearer token lives in Keychain: Raycast / raycast-store_credentials (it is the rca_... oauth.access_token).",
      "Device ID = analyticsId in ~/Library/Application Support/com.raycast.macos/posthog.distinctId.",
      "Signature JWT is optional with current Raycast builds.",
    ],
    requiredFields: [
      {
        name: "accessToken",
        label: "Bearer Token",
        description: "From Authorization: Bearer header on backend.raycast.com requests (starts with rca_)",
        type: "textarea",
      },
      {
        name: "deviceId",
        label: "Device ID",
        description: "From X-Raycast-DeviceId header",
        type: "text",
      },
      {
        name: "signatureJwt",
        label: "Signature JWT",
        description: "From X-Raycast-Signature header (optional; AID decoded automatically)",
        type: "textarea",
      },
      {
        name: "sigSecret",
        label: "Signature Secret",
        description: "Optional override — defaults to community-extracted SIG_SECRET",
        type: "text",
      },
    ],
  });
}