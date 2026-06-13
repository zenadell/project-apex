```jsx
/**
 * frontend/src/components/StatusDot.js
 *
 * Reusable status dot indicator for connection state.
 * Renders a small circle whose color and animation reflect the current
 * WebSocket connection status. Designed for the APEX dark glassmorphism UI.
 *
 * Statuses:
 *  - "connected"    : solid green (#00ff88), subtle static glow
 *  - "connecting"   : pulsing yellow / secondary (#a855f7), animated pulse
 *  - "disconnected" : solid red (#ff0050), no glow
 *  - "error"        : solid red (#ff0050), short strobe (error state)
 *
 * Accessibility: includes an `aria-label` describing the status.
 * Theme: uses the project's design tokens for colors and supports
 *        dark backgrounds.
 */

import React from 'react';

const STATUS_COLORS = {
  connected: '#00ff88',
  connecting: '#a855f7',
  disconnected: '#ff0050',
  error: '#ff0050',
};

const STATUS_LABELS = {
  connected: 'Connected',
  connecting: 'Connecting',
  disconnected: 'Disconnected',
  error: 'Error',
};

const StatusDot = ({ status = 'disconnected', size = 12 }) => {
  // Normalise to known keys (map any extra values to disconnected)
  const safeStatus = STATUS_COLORS[status] ? status : 'disconnected';
  const color = STATUS_COLORS[safeStatus];
  const label = STATUS_LABELS[safeStatus];
  const isConnecting = safeStatus === 'connecting';
  const isError = safeStatus === 'error';

  const dotStyle = {
    width: size,
    height: size,
    borderRadius: '50%',
    backgroundColor: color,
    boxShadow: isConnecting
      ? `0 0 6px ${color}, 0 0 12px ${color}80`
      : `0 0 4px ${color}40`,
    animation: isConnecting
      ? 'dotPulse 1.5s ease-in-out infinite'
      : isError
      ? 'dotError 0.6s ease-in-out 3'
      : 'none',
    // Ensure dot is visible on dark backgrounds
    border: '1px solid rgba(255,255,255,0.1)',
    display: 'inline-block',
    verticalAlign: 'middle',
    flexShrink: 0,
    // Smooth transition between statuses
    transition: 'background-color 0.3s, box-shadow 0.3s',
  };

  return (
    <span
      className="status-dot"
      style={dotStyle}
      aria-label={`Status: ${label}`}
      role="status"
    >
      {/* Inject keyframes once — the parent App.css can also define them.
          Using a <style> tag would be messy, so we rely on a global CSS
          animation defined in index.html or App.css. For maximum portability,
          we declare the keyframes below using a <style> tag that is only
          rendered once per component lifecycle. */}
      <style>{`
        @keyframes dotPulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.3); opacity: 0.7; }
        }
        @keyframes dotError {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.2; }
        }
      `}</style>
    </span>
  );
};

export default StatusDot;
```