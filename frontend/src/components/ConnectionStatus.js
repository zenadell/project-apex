```jsx
/**
 * frontend/src/components/ConnectionStatus.js
 *
 * Connection status indicator component.
 * Displays the current WebSocket state with a visual indicator,
 * status text, and an optional reconnect button.
 *
 * Uses the APEX design system:
 *  - Dark glassmorphism surface with neon accents
 *  - Semi‑transparent backdrop blur card
 *  - Colored dot for connection state (green, red, yellow, white)
 *  - Subtle pulse animation while reconnecting
 *  - Reconnect button with neon glow on hover/focus
 *
 * Props:
 *  - status: 'connected' | 'disconnected' | 'reconnecting' | 'error'
 *  - lastReconnectAttempt: Date | null   // for displaying time ago (optional)
 *  - onReconnect: function                // callback to trigger manual reconnect
 */

import React, { useMemo } from 'react';

// ---------- style config ----------
const colors = {
  primary: '#00d4ff',
  secondary: '#a855f7',
  accent: '#ff0050',
  background: '#0a0a0f',
  surface: '#1a1a2e',
  text: '#e0e0e0',
  textMuted: '#888',
  border: '#2a2a3e',
  error: '#ff0050',
  success: '#00ff88',
};

const indicatorColors = {
  connected: colors.success,
  disconnected: colors.error,
  reconnecting: colors.primary,
  error: colors.accent,
};

const statusLabels = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting…',
  error: 'Connection Error',
};

const pulseKeyframes = `
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
`;

// ---------- helper: relative time ----------
function timeAgo(date) {
  if (!date) return '';
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

// ---------- component ----------
const ConnectionStatus = ({ status = 'disconnected', lastReconnectAttempt, onReconnect }) => {
  const indicatorColor = indicatorColors[status] || colors.textMuted;
  const label = statusLabels[status] || 'Unknown';

  // determine if we should show reconnection countdown / time
  const lastAttemptText = useMemo(() => {
    if (status !== 'reconnecting' && status !== 'disconnected') return null;
    if (!lastReconnectAttempt) return null;
    return `Last attempt: ${timeAgo(lastReconnectAttempt)}`;
  }, [status, lastReconnectAttempt]);

  const isReconnecting = status === 'reconnecting';
  const isDisconnected = status === 'disconnected';
  const isError = status === 'error';

  // full container style
  const containerStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '12px 20px',
    background: 'rgba(26, 26, 46, 0.75)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: `1px solid ${colors.border}`,
    borderRadius: '12px',
    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
    width: '100%',
    maxWidth: '400px',
    transition: 'border-color 0.3s, box-shadow 0.3s',
    // subtle noise overlay simulation (via background)
    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
    backgroundBlendMode: 'overlay',
    backgroundSize: '200px 200px',
    opacity: 0.08, // very subtle noise
  };

  // indicator dot
  const dotStyle = {
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    backgroundColor: indicatorColor,
    boxShadow: `0 0 8px ${indicatorColor}`,
    animation: isReconnecting ? 'pulse-dot 1.5s ease-in-out infinite' : 'none',
    flexShrink: 0,
  };

  // label & details
  const labelStyle = {
    fontFamily: "'Inter', 'system-ui', sans-serif",
    fontSize: '0.9rem',
    fontWeight: 500,
    color: colors.text,
    letterSpacing: '0.3px',
  };

  const detailStyle = {
    fontFamily: "'Inter', 'system-ui', sans-serif",
    fontSize: '0.75rem',
    color: colors.textMuted,
    marginTop: '2px',
  };

  // reconnect button
  const buttonStyle = {
    fontFamily: "'Inter', 'system-ui', sans-serif",
    fontSize: '0.8rem',
    fontWeight: 600,
    padding: '6px 16px',
    background: 'transparent',
    color: colors.primary,
    border: `1px solid ${colors.primary}`,
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    outline: 'none',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    boxShadow: '0 0 0 transparent',
  };

  return (
    <>
      {/* inject keyframes once */}
      <style>{pulseKeyframes}</style>

      <div
        role="status"
        aria-live="polite"
        aria-label={`Connection status: ${label}`}
        style={containerStyle}
        // subtle glow on status changes
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = indicatorColor;
          e.currentTarget.style.boxShadow = `0 0 15px ${indicatorColor}40`;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = colors.border;
          e.currentTarget.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3)';
        }}
      >
        {/* left side: dot + text */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
          <span style={dotStyle} aria-hidden="true" />
          <div style={{ overflow: 'hidden' }}>
            <div style={labelStyle}>{label}</div>
            {lastAttemptText && (
              <div style={detailStyle}>{lastAttemptText}</div>
            )}
            {isError && !lastAttemptText && (
              <div style={{ ...detailStyle, color: colors.accent }}>
                Try refreshing or check network
              </div>
            )}
          </div>
        </div>

        {/* right side: reconnect button on failure */}
        {(isDisconnected || isError) && !isReconnecting && (
          <button
            onClick={onReconnect}
            style={buttonStyle}
            // hover/focus neon glow
            onFocus={(e) => {
              e.currentTarget.style.boxShadow = `0 0 10px ${colors.primary}`;
            }}
            onBlur={(e) => {
              e.currentTarget.style.boxShadow = '0 0 0 transparent';
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = `${colors.primary}15`;
              e.currentTarget.style.boxShadow = `0 0 12px ${colors.primary}`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.boxShadow = '0 0 0 transparent';
            }}
          >
            Reconnect
          </button>
        )}

        {/* when reconnecting, show a subtle spinner/animation inside the dot is enough */}
      </div>
    </>
  );
};

export default ConnectionStatus;
```