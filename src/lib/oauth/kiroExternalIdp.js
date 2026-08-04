/**
 * kiroExternalIdp.js — shared helpers for Kiro / Amazon Q External IdP
 * (enterprise "Your organization" SSO) accounts.
 *
 * Unlike AWS Builder ID / IAM Identity Center (which mint AWS SSO-OIDC tokens)
 * or the Google/GitHub social flow, an External IdP login federates through the
 * organization's own identity provider (Microsoft Entra, Okta, Auth0, etc.).
 * Its refresh token is refreshed with a standard public-client OAuth2
 * refresh_token grant against the org IdP's tokenEndpoint.
 */

const ALLOWED_IDP_HOST_SUFFIXES = [
  "login.microsoftonline.com",
  "login.microsoftonline.us",
  "login.partner.microsoftonline.cn",
  "login.microsoft.com",
  "login.windows.net",
  "sts.windows.net",
  ".okta.com",
  ".oktapreview.com",
  ".okta-emea.com",
  ".auth0.com",
  ".onelogin.com",
  ".pingidentity.com",
  ".pingone.com",
  "accounts.google.com",
  "oauth2.googleapis.com",
  ".amazoncognito.com",
];

const DEFAULT_REGION = "us-east-1";
const DEFAULT_EXPIRES_IN = 3600;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** True when a connection's providerSpecificData marks it as an External IdP login. */
export function isExternalIdpAuthMethod(authMethod) {
  return normalizeString(authMethod).toLowerCase() === "external_idp";
}

/**
 * Validate the IdP token endpoint before it is used as a fetch target. Requires
 * https and a host on ALLOWED_IDP_HOST_SUFFIXES. Returns the normalized URL string.
 */
export function validateExternalIdpTokenEndpoint(rawEndpoint) {
  const tokenEndpoint = normalizeString(rawEndpoint);
  if (!tokenEndpoint) throw new Error("tokenEndpoint is required for external_idp");

  let parsed;
  try {
    parsed = new URL(tokenEndpoint);
  } catch {
    throw new Error("tokenEndpoint must be a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("tokenEndpoint must use https");
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_IDP_HOST_SUFFIXES.some((suffix) =>
    suffix.startsWith(".") ? host.endsWith(suffix) : host === suffix
  );

  if (!allowed) {
    throw new Error(`tokenEndpoint host is not an allowed identity provider: ${host}`);
  }

  return parsed.toString();
}

export function normalizeScope(scopes) {
  if (Array.isArray(scopes)) {
    return scopes.map(normalizeString).filter(Boolean).join(" ");
  }
  return normalizeString(scopes);
}

export function decodeJwtPayload(jwt) {
  try {
    if (!jwt || typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (base64.length % 4)) % 4;
    return JSON.parse(Buffer.from(`${base64}${"=".repeat(padding)}`, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** Extract email from an External IdP access token JWT. */
export function emailFromExternalIdpToken(accessToken) {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return null;
  const pick = (k) => (typeof claims[k] === "string" ? claims[k] : undefined);
  return pick("email") || pick("preferred_username") || pick("upn") || null;
}

function resolveExpiresAt(input) {
  const explicit = input.expired || input.expires_at || input.expiresAt;
  if (explicit) {
    const ms = new Date(explicit).getTime();
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }

  const expiresIn = Number(input.expires_in || input.expiresIn || 0);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000).toISOString();
  }

  const payload = decodeJwtPayload(input.access_token || input.accessToken);
  if (payload?.exp) {
    return new Date(payload.exp * 1000).toISOString();
  }

  return new Date(Date.now() + DEFAULT_EXPIRES_IN * 1000).toISOString();
}

export function normalizeKiroExternalIdpAuth(rawAuth) {
  let input = rawAuth;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw new Error("CLIProxyAPI auth JSON is invalid");
    }
  }

  if (!input || typeof input !== "object") {
    throw new Error("CLIProxyAPI auth JSON is required");
  }

  const authMethod = normalizeString(input.auth_method || input.authMethod);
  if (authMethod && authMethod !== "external_idp") {
    throw new Error("Only external_idp Kiro auth is supported by this importer");
  }

  const accessToken = normalizeString(input.access_token || input.accessToken);
  const refreshToken = normalizeString(input.refresh_token || input.refreshToken);
  const clientId = normalizeString(input.client_id || input.clientId);
  const tokenEndpoint = validateExternalIdpTokenEndpoint(input.token_endpoint || input.tokenEndpoint);
  const profileArn = normalizeString(input.profile_arn || input.profileArn);
  const region = normalizeString(input.region) || DEFAULT_REGION;
  const scope = normalizeScope(input.scopes || input.scope);

  if (!accessToken) throw new Error("access_token is required");
  if (!refreshToken) throw new Error("refresh_token is required");
  if (!clientId) throw new Error("client_id is required");
  if (!scope) throw new Error("scopes is required");
  if (!profileArn) throw new Error("profile_arn is required");

  const email = emailFromExternalIdpToken(accessToken) || input.email || null;

  return {
    accessToken,
    refreshToken,
    expiresAt: resolveExpiresAt(input),
    email,
    providerSpecificData: {
      profileArn,
      region,
      authMethod: "external_idp",
      provider: "CLIProxyAPI",
      clientId,
      tokenEndpoint,
      scope,
    },
  };
}

export function buildExternalIdpRefreshParams(refreshToken, providerSpecificData = {}) {
  const clientId = normalizeString(providerSpecificData.clientId || providerSpecificData.client_id);
  const tokenEndpoint = validateExternalIdpTokenEndpoint(
    providerSpecificData.tokenEndpoint || providerSpecificData.token_endpoint
  );
  const scope = normalizeScope(providerSpecificData.scope || providerSpecificData.scopes);

  if (!refreshToken) throw new Error("refresh token is required");
  if (!clientId) throw new Error("clientId is required for external_idp refresh");
  if (!scope) throw new Error("scope is required for external_idp refresh");

  return {
    tokenEndpoint,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      scope,
    }),
    providerSpecificData: {
      ...providerSpecificData,
      authMethod: "external_idp",
      clientId,
      tokenEndpoint,
      scope,
    },
  };
}
