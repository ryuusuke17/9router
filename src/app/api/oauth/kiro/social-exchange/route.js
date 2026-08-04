import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection, updateProviderConnection, getProviderConnections } from "@/models";
import { KIRO_CONFIG } from "@/lib/oauth/constants/oauth";

/**
 * POST /api/oauth/kiro/social-exchange
 * Poll device code for tokens (Google/GitHub social login device flow).
 * Frontend calls this repeatedly until authorization completes.
 */
export async function POST(request) {
  try {
    const { deviceCode, provider } = await request.json();

    if (!deviceCode || !provider || !["google", "github"].includes(provider)) {
      return NextResponse.json(
        { error: "Missing deviceCode or invalid provider" },
        { status: 400 }
      );
    }

    const response = await fetch(KIRO_CONFIG.socialDevicePollUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode, clientId: KIRO_CONFIG.socialClientId }),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      const isPending =
        data.error === "authorization_pending" || data.error === "slow_down";

      return NextResponse.json({
        success: false,
        pending: isPending,
        error: data.error || "Authorization failed",
      });
    }

    const kiroService = new KiroService();
    const email = kiroService.extractEmailFromJWT(data.accessToken);

    const providerSpecificData = {
      authMethod: "imported",
      provider: provider.charAt(0).toUpperCase() + provider.slice(1),
    };

    if (data.profileArn) {
      providerSpecificData.profileArn = data.profileArn;
    }

    const record = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: new Date(Date.now() + (data.expiresIn || 3600) * 1000).toISOString(),
      email: email || null,
      providerSpecificData,
      testStatus: "active",
      isActive: true,
    };

    const existing = await getProviderConnections({ provider: "kiro" });
    const match = existing.find((c) => {
      const sd = c.providerSpecificData;
      return (
        sd?.authType === "oauth" &&
        sd?.profileArn === data.profileArn &&
        c.email === email
      );
    });

    let connection;
    if (match?.id) {
      connection = await updateProviderConnection(match.id, record);
    } else {
      connection = await createProviderConnection({
        provider: "kiro",
        authType: "oauth",
        ...record,
      });
    }

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    console.error("Kiro social exchange error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
