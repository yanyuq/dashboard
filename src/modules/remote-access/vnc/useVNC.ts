import { useCallback, useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";
import { installVNCWebSocketProxy, sendRawToVNCProxy } from "./websocket-proxy";

export enum VNCStatus {
  DISCONNECTED = 0,
  CONNECTED = 1,
  CONNECTING = 2,
}

export type VNCMode = "attach" | "session";

// Stable reject codes emitted by the NetBird VNC server (client/vnc/server).
// Must stay in sync with RejectCode* constants in client/vnc/server/server.go.
export enum VNCRejectCode {
  JWT_MISSING = "AUTH_JWT_MISSING",
  JWT_EXPIRED = "AUTH_JWT_EXPIRED",
  JWT_INVALID = "AUTH_JWT_INVALID",
  AUTH_FORBIDDEN = "AUTH_FORBIDDEN",
  AUTH_CONFIG = "AUTH_CONFIG",
  SESSION_ERROR = "SESSION_ERROR",
  CAPTURER_ERROR = "CAPTURER_ERROR",
  UNSUPPORTED = "UNSUPPORTED",
  BAD_REQUEST = "BAD_REQUEST",
}

export interface VNCError {
  code?: VNCRejectCode;
  message: string;
  // friendly is a short, user-facing string derived from the code, suitable
  // for display in a toast or inline alert without further formatting.
  friendly: string;
}

const friendlyByCode: Record<string, string> = {
  [VNCRejectCode.JWT_MISSING]: "Sign-in required to connect.",
  [VNCRejectCode.JWT_EXPIRED]: "Your session has expired. Please sign in again.",
  [VNCRejectCode.JWT_INVALID]: "Authentication failed. Please sign in again.",
  [VNCRejectCode.AUTH_FORBIDDEN]: "You are not allowed to connect to this peer.",
  [VNCRejectCode.AUTH_CONFIG]: "Remote access is not configured correctly on the peer.",
  [VNCRejectCode.SESSION_ERROR]: "Could not start the virtual session on the peer.",
  [VNCRejectCode.CAPTURER_ERROR]: "The peer cannot capture its screen. Check Screen Recording permission on macOS or the display on Linux.",
  [VNCRejectCode.UNSUPPORTED]: "This action is not supported on the peer's platform.",
  [VNCRejectCode.BAD_REQUEST]: "The connection request was rejected by the peer.",
};

// parseVNCRejection splits a security-failure reason sent by the NetBird VNC
// server into its machine code and free-text message. Also works on plain
// messages from other VNC servers (returns them unchanged with friendly=msg).
export const parseVNCRejection = (reason: string): VNCError => {
  const raw = (reason || "VNC connection rejected").trim();
  const sep = raw.indexOf(": ");
  if (sep > 0) {
    const prefix = raw.slice(0, sep);
    const message = raw.slice(sep + 2);
    if ((Object.values(VNCRejectCode) as string[]).includes(prefix)) {
      const code = prefix as VNCRejectCode;
      return { code, message, friendly: friendlyByCode[code] || message };
    }
  }
  return { message: raw, friendly: raw };
};

interface VNCConfig {
  hostname: string;
  port: number;
  mode?: VNCMode;
  username?: string;
  jwt?: string;
  sessionID?: number;
  width?: number;
  height?: number;
  scale?: boolean;
  resize?: boolean;
  quality?: number;
  dotCursor?: boolean;
}

interface VNCClient {
  client?: {
    createVNCProxy: (
      hostname: string,
      port: string,
      mode: string,
      username: string,
      jwt: string,
      sessionID: number,
      width: number,
      height: number,
    ) => Promise<string>;
  };
}

export const useVNC = (client: VNCClient) => {
  const [status, setStatus] = useState(VNCStatus.DISCONNECTED);
  const statusRef = useRef(VNCStatus.DISCONNECTED);
  const [error, setError] = useState<string>("");
  const errorDetailRef = useRef<VNCError | null>(null);

  const reportError = useCallback((err: VNCError) => {
    errorDetailRef.current = err;
    setError(err.friendly);
  }, []);

  const clearError = useCallback(() => {
    errorDetailRef.current = null;
    setError("");
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const proxyInstalledRef = useRef(false);
  const proxyIDRef = useRef<string>("");

  const updateStatus = useCallback((s: VNCStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const disconnect = useCallback(() => {
    if (rfbRef.current) {
      try {
        rfbRef.current.disconnect();
      } catch {
        // ignore disconnect errors
      }
      rfbRef.current = null;
    }
    proxyIDRef.current = "";
    updateStatus(VNCStatus.DISCONNECTED);
  }, [updateStatus]);

  const connect = useCallback(
    async (config: VNCConfig) => {
      if (statusRef.current === VNCStatus.CONNECTING) return;

      updateStatus(VNCStatus.CONNECTING);
      clearError();

      try {
        if (!containerRef.current) {
          throw new Error("VNC container not available");
        }

        if (!client?.client?.createVNCProxy) {
          throw new Error("NetBird client is not ready yet, please reload the page");
        }

        // Install WebSocket proxy if not already done.
        if (!proxyInstalledRef.current) {
          installVNCWebSocketProxy();
          proxyInstalledRef.current = true;
        }

        // Create the VNC proxy through the NetBird tunnel. proxyURL is
        // wss://vnc.proxy.local/<proxyID>; capture the ID so the toolbar
        // can send NetBird-specific RFB messages out-of-band.
        const proxyURL: string = await client.client.createVNCProxy(
          config.hostname,
          String(config.port),
          config.mode || "attach",
          config.username || "",
          config.jwt || "",
          config.sessionID || 0,
          config.width || 0,
          config.height || 0,
        );

        const proxyIDMatch = proxyURL.match(/vnc\.proxy\.local\/(.+)/);
        const proxyID = proxyIDMatch?.[1] || "default";

        const { default: RFB } = await import("@novnc/novnc");

        // noVNC creates its own canvas inside the container div.
        const rfb = new RFB(containerRef.current, proxyURL, {
          wsProtocols: [],
        });

        rfb.scaleViewport = config.scale ?? true;
        rfb.resizeSession = config.resize ?? false;
        rfb.clipViewport = false;
        // Default off: we rely on the browser's native cursor via CSS on the
        // container (.vnc-cursor) so the user sees a real arrow instead of
        // noVNC's single-pixel dot fallback.
        rfb.showDotCursor = config.dotCursor ?? false;
        rfb.focusOnClick = true;
        if (config.quality !== undefined) {
          rfb.qualityLevel = config.quality;
        }

        const connectTimeout = setTimeout(() => {
          if (rfbRef.current && statusRef.current !== VNCStatus.CONNECTED) {
            reportError({
              message: "VNC connection timed out",
              friendly: "VNC connection timed out. The peer may be unreachable or restarting.",
            });
            try { rfb.disconnect(); } catch {}
            rfbRef.current = null;
            updateStatus(VNCStatus.DISCONNECTED);
          }
        }, 20000);

        rfb.addEventListener("connect", () => {
          clearTimeout(connectTimeout);
          updateStatus(VNCStatus.CONNECTED);
          rfb.focus();
        });

        rfb.addEventListener("disconnect", (e: Event) => {
          clearTimeout(connectTimeout);
          const detail = (e as CustomEvent<{ clean?: boolean }>).detail || {};
          // securityfailure fires before disconnect and has already set the
          // specific reason; don't overwrite it with a generic message.
          if (!detail.clean && !errorDetailRef.current) {
            reportError({
              message: "VNC connection lost unexpectedly",
              friendly: "VNC connection lost unexpectedly",
            });
          }
          updateStatus(VNCStatus.DISCONNECTED);
          rfbRef.current = null;
        });

        rfb.addEventListener("securityfailure", (e: Event) => {
          clearTimeout(connectTimeout);
          const detail = (e as CustomEvent<{ reason?: string }>).detail || {};
          reportError(parseVNCRejection(detail.reason ?? ""));
        });

        // Server → browser clipboard: write to browser clipboard when server sends text.
        rfb.addEventListener("clipboard", (e: Event) => {
          const text = (e as CustomEvent<{ text?: string }>).detail?.text;
          if (text && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
          }
        });

        // Browser → server clipboard: keep host clipboard in sync with
        // the remote OS clipboard on every window focus. The server side
        // only writes to the OS clipboard (no auto-typing), so this is
        // safe and lets Ctrl+V work normally on a logged-in desktop. The
        // Paste toolbar button is the only path that synthesizes
        // keystrokes (for Winlogon/UAC).
        const sendClipboard = () => {
          if (navigator.clipboard?.readText) {
            navigator.clipboard.readText().then((text) => {
              if (text && rfbRef.current) {
                rfbRef.current.clipboardPasteFrom(text);
              }
            }).catch(() => {});
          }
        };
        window.addEventListener("focus", sendClipboard);
        rfb.addEventListener("disconnect", () => {
          window.removeEventListener("focus", sendClipboard);
        });

        rfbRef.current = rfb;
        proxyIDRef.current = proxyID;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "VNC connection failed";
        reportError({ message: errorMessage, friendly: errorMessage });
        updateStatus(VNCStatus.DISCONNECTED);
        throw new Error(errorMessage);
      }
    },
    [client, updateStatus, clearError, reportError],
  );

  // Handle window resize.
  useEffect(() => {
    if (!rfbRef.current || status !== VNCStatus.CONNECTED) return;

    let timeout: NodeJS.Timeout;
    const handleResize = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        rfbRef.current?.scaleViewport && rfbRef.current._updateScale?.();
      }, 200);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      clearTimeout(timeout);
    };
  }, [status]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  const sendCtrlAltDel = useCallback(() => {
    rfbRef.current?.sendCtrlAltDel();
    rfbRef.current?.focus();
  }, []);

  const pasteFromHostClipboard = useCallback(async (): Promise<boolean> => {
    if (!rfbRef.current || !navigator.clipboard?.readText) return false;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return false;
      // Send a NetBird-specific RFB message (clientNetbirdTypeText = 250)
      // that asks the server to type the text via SendInput. Wire format:
      // 1-byte msgType + 3-byte padding + 4-byte length + UTF-8 bytes.
      const utf8 = new TextEncoder().encode(text);
      const buf = new Uint8Array(8 + utf8.length);
      buf[0] = 250;
      const view = new DataView(buf.buffer);
      view.setUint32(4, utf8.length, false);
      buf.set(utf8, 8);
      const sent = sendRawToVNCProxy(proxyIDRef.current, buf);
      if (!sent) {
        // Fall back to standard CutText so we at least update the OS
        // clipboard when the type path isn't available.
        rfbRef.current.clipboardPasteFrom(text);
      }
      rfbRef.current.focus();
      return true;
    } catch {
      return false;
    }
  }, []);

  const focus = useCallback(() => {
    rfbRef.current?.focus();
  }, []);

  return {
    connect,
    disconnect,
    sendCtrlAltDel,
    pasteFromHostClipboard,
    focus,
    status,
    error,
    containerRef,
  };
};
