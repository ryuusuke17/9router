"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

/**
 * Kiro Social OAuth Modal (Google/GitHub)
 * Uses device code flow — no manual callback URL copy-paste needed.
 */
export default function KiroSocialOAuthModal({ isOpen, provider, onSuccess, onClose }) {
  const [step, setStep] = useState("loading"); // loading | polling | success | error
  const [authUrl, setAuthUrl] = useState("");
  const [userCode, setUserCode] = useState("");
  const [error, setError] = useState(null);
  const { copied, copy } = useCopyToClipboard();
  const pollRef = useRef(null);
  const openedRef = useRef(false);
  const onSuccessRef = useRef(onSuccess);

  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  // Reset auto-open guard when modal closes
  useEffect(() => {
    if (!isOpen) {
      openedRef.current = false;
    }
  }, [isOpen]);

  // Initialize device flow and poll for tokens
  useEffect(() => {
    if (!isOpen || !provider) return;
    let cancelled = false;

    const stopPolling = () => {
      if (pollRef.current) clearTimeout(pollRef.current);
      pollRef.current = null;
    };

    const fail = (message) => {
      stopPolling();
      if (cancelled) return;
      setError(message);
      setStep("error");
    };

    const initAuth = async () => {
      try {
        setError(null);
        setStep("loading");

        const res = await fetch(`/api/oauth/kiro/social-authorize?provider=${provider}`);
        const data = await res.json();
        if (cancelled) return;

        if (!res.ok) {
          throw new Error(data.error || "Failed to start authorization");
        }

        setUserCode(data.userCode || "");
        setAuthUrl(data.authUrl || "");
        setStep("polling");

        // Auto-open browser once per modal session
        if (!openedRef.current && data.authUrl) {
          openedRef.current = true;
          window.open(data.authUrl, "_blank");
        }

        const baseIntervalMs = Math.max(1, Number(data.interval) || 5) * 1000;
        let currentIntervalMs = baseIntervalMs;
        const expiresAt = Date.now() + Math.max(1, Number(data.expiresIn) || 300) * 1000;

        const schedule = (delayMs) => {
          if (cancelled) return;
          pollRef.current = setTimeout(poll, delayMs);
        };

        const poll = async () => {
          pollRef.current = null;
          if (cancelled) return;
          if (Date.now() >= expiresAt) {
            fail("Authorization expired. Start the login flow again.");
            return;
          }

          try {
            const pollRes = await fetch("/api/oauth/kiro/social-exchange", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ deviceCode: data.deviceCode, provider }),
            });
            const pollData = await pollRes.json();
            if (cancelled) return;

            if (pollData.success) {
              stopPolling();
              setStep("success");
              onSuccessRef.current?.();
              return;
            }

            if (!pollData.pending) {
              fail(pollData.error || "Authorization failed");
              return;
            }

            // Respect slow_down by doubling interval
            if (pollData.error === "slow_down") {
              currentIntervalMs = Math.min(currentIntervalMs * 2, 30000);
            }
            schedule(currentIntervalMs);
          } catch {
            // Network error — retry after interval
            schedule(currentIntervalMs);
          }
        };

        schedule(baseIntervalMs);
      } catch (err) {
        fail(err.message);
      }
    };

    initAuth();

    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [isOpen, provider]);

  const handleClose = () => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    onClose();
  };

  const providerName = provider === "google" ? "Google" : "GitHub";

  return (
    <Modal isOpen={isOpen} title={`Connect Kiro via ${providerName}`} onClose={handleClose} size="lg">
      <div className="flex flex-col gap-4">
        {/* Loading */}
        {step === "loading" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-primary animate-spin">
                progress_activity
              </span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Initializing...</h3>
            <p className="text-sm text-text-muted">
              Setting up {providerName} authentication
            </p>
          </div>
        )}

        {/* Polling Step */}
        {step === "polling" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-primary animate-pulse">
                open_in_browser
              </span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Open this link in an Incognito window</h3>
            <p className="text-sm text-text-muted mb-3">
              Use an Incognito/Private window to avoid session conflicts with existing accounts.
            </p>
            {authUrl && (
              <div className="mb-4">
                <div className="flex items-center gap-2 justify-center">
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-mono text-primary underline break-all max-w-md inline-block"
                  >
                    {authUrl.length > 80 ? authUrl.slice(0, 80) + "..." : authUrl}
                  </a>
                  <button
                    onClick={() => copy(authUrl, "auth_url")}
                    className="shrink-0 p-1 rounded hover:bg-sidebar"
                    title="Copy link"
                  >
                    <span className="material-symbols-outlined text-base">
                      {copied === "auth_url" ? "check" : "content_copy"}
                    </span>
                  </button>
                </div>
              </div>
            )}
            {userCode && (
              <div className="mb-4">
                <p className="text-xs text-text-muted mb-1">Verification code</p>
                <p className="font-mono text-2xl font-bold tracking-widest">{userCode}</p>
              </div>
            )}
            <div className="flex items-center justify-center gap-2 text-sm text-text-muted">
              <span className="material-symbols-outlined text-base animate-spin">
                progress_activity
              </span>
              Waiting for authorization...
            </div>
            <div className="mt-6">
              <Button onClick={handleClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Success */}
        {step === "success" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-green-600">
                check_circle
              </span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Connected Successfully!</h3>
            <p className="text-sm text-text-muted mb-4">
              Your Kiro account via {providerName} has been connected.
            </p>
            <Button onClick={handleClose} fullWidth>
              Done
            </Button>
          </div>
        )}

        {/* Error */}
        {step === "error" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-red-600">error</span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Connection Failed</h3>
            <p className="text-sm text-red-600 mb-4">{error}</p>
            <div className="flex gap-2">
              <Button onClick={() => setStep("loading")} variant="secondary" fullWidth>
                Try Again
              </Button>
              <Button onClick={handleClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

KiroSocialOAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.oneOf(["google", "github"]).isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
