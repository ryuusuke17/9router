"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";

/**
 * Raycast Pro AI Auth Modal
 * Import Bearer token + X-Raycast-DeviceId (+ optional signature JWT/secret) from
 * backend.raycast.com traffic. On macOS offers one-click auto-import from Keychain
 * + the local Raycast encrypted DB (needs sqlcipher).
 */
export default function RaycastAuthModal({ isOpen, onSuccess, onClose }) {
  const [accessToken, setAccessToken] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [signatureJwt, setSignatureJwt] = useState("");
  const [sigSecret, setSigSecret] = useState("");
  const [importing, setImporting] = useState(false);
  const [autoAvailable, setAutoAvailable] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    fetch("/api/oauth/raycast/auto-import")
      .then((r) => r.json())
      .then((d) => setAutoAvailable(!!d.available))
      .catch(() => setAutoAvailable(false));
  }, [isOpen]);

  const handleAutoImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/raycast/auto-import", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : data.error?.message || "Auto-import failed");
      }
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const handleImportToken = async () => {
    if (!accessToken.trim() || !deviceId.trim()) {
      setError("Bearer token and Device ID are required.");
      return;
    }

    setImporting(true);
    setError(null);

    try {
      const body = { accessToken: accessToken.trim(), deviceId: deviceId.trim() };
      if (signatureJwt.trim()) body.signatureJwt = signatureJwt.trim();
      if (sigSecret.trim()) body.sigSecret = sigSecret.trim();

      const res = await fetch("/api/oauth/raycast/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : data.error?.message || "Import failed");
      }
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Connect Raycast Pro AI" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="bg-emerald-50 dark:bg-emerald-900/20 p-4 rounded-lg border border-emerald-200 dark:border-emerald-800">
          <p className="text-sm text-emerald-900 dark:text-emerald-200 mb-3">
            <strong>Auto-import (macOS):</strong> reads your local Raycast login from Keychain +
            analytics device ID. No proxy needed.
          </p>
          <Button onClick={handleAutoImport} fullWidth disabled={importing || !autoAvailable}>
            {importing ? "Importing..." : autoAvailable ? "Auto-Import from Local Raycast" : "Auto-Import unavailable (need macOS + sqlcipher)"}
          </Button>
          {!autoAvailable && (
            <p className="text-xs text-emerald-800 dark:text-emerald-300 mt-2">
              Install sqlcipher on macOS: <span className="font-mono">brew install sqlcipher</span>
            </p>
          )}
        </div>

        <div className="bg-amber-50 dark:bg-amber-900/20 p-4 rounded-lg border border-amber-200 dark:border-amber-800">
          <p className="text-sm text-amber-900 dark:text-amber-200">
            <strong>Local dev only.</strong> Uses your Raycast Pro subscription via reverse-engineered
            API. Not official — may break on Raycast updates.
          </p>
          <button
            type="button"
            className="text-xs text-amber-800 dark:text-amber-300 underline mt-2"
            onClick={() => setShowManual((v) => !v)}
          >
            {showManual ? "Hide manual import" : "Manual import (proxy capture)"}
          </button>
        </div>

        {showManual && (
          <>
            <div>
              <label className="block text-sm font-medium mb-2">
                Bearer Token <span className="text-red-500">*</span>
              </label>
              <textarea
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="rca_... (the OAuth token from Keychain — NOT the csrf_token cookie)"
                rows={3}
                className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-background focus:outline-none focus:border-primary resize-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                Device ID <span className="text-red-500">*</span>
              </label>
              <Input
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                placeholder="analyticsId / X-Raycast-DeviceId"
                className="font-mono text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                Signature JWT <span className="text-text-muted">(optional)</span>
              </label>
              <textarea
                value={signatureJwt}
                onChange={(e) => setSignatureJwt(e.target.value)}
                placeholder="X-Raycast-Signature (optional on current builds)"
                rows={2}
                className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-background focus:outline-none focus:border-primary resize-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                SIG_SECRET <span className="text-text-muted">(optional)</span>
              </label>
              <Input
                value={sigSecret}
                onChange={(e) => setSigSecret(e.target.value)}
                placeholder="Override if Raycast rotated signing key"
                className="font-mono text-sm"
              />
            </div>

            <Button
              onClick={handleImportToken}
              fullWidth
              disabled={importing || !accessToken.trim() || !deviceId.trim()}
            >
              {importing ? "Importing..." : "Import Manually"}
            </Button>
          </>
        )}

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <Button onClick={onClose} variant="ghost" fullWidth>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

RaycastAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};