import { RAYCAST_CONFIG } from "../constants/oauth.js";

/**
 * Raycast Pro AI — token-import OAuth provider (reverse-engineered, local use only).
 * Requires a Bearer token, X-Raycast-DeviceId, and optional X-Raycast-Signature JWT
 * captured from backend.raycast.com traffic (macOS Raycast app).
 */
const raycast = {
  config: RAYCAST_CONFIG,
  flowType: "import_token",
  mapTokens: (tokens) => ({
    accessToken: tokens.accessToken || tokens.access_token,
    refreshToken: null,
    expiresIn: tokens.expiresIn || 30 * 24 * 60 * 60,
    providerSpecificData: {
      deviceId: tokens.deviceId || tokens.device_id || "",
      aid: tokens.aid || "",
      sigSecret: tokens.sigSecret || tokens.signatureSecret || "",
      authMethod: "imported",
    },
  }),
};

export default raycast;