```jsx
/**
 * frontend/src/components/LogEntry.js
 *
 * Individual log entry card for the APEX real‑time log feed.
 * Displays the log level, timestamp, and message in a glassmorphism card
 * that follows the project’s dark neon design system.
 *
 * Props:
 *   log: { timestamp: string, message: string, level: 'info'|'warn'|'error'|'success' }
 *
 * Accessibility:
 *   - role="log" with aria-live="polite" for screen reader updates.
 *   - Semantic `<time>` element for the timestamp.
 *   - Colour and icon not used as sole indicators (text label present).
 */

import React from 'react';

// ── Design tokens (matching the project’s theme) ──────────────────────
const COLORS = {
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

// ── Level configuration ───────────────────────────────────────────────
const LEVEL_STYLES = {
  info: {
    dotBackground: COLORS.primary,
    label: 'Info',
    cardBorderColor: 'rgba(0, 212, 255, 0.3)',
  },
  warn: {
    dotBackground: COLORS.secondary,
    label: 'Warning',
    cardBorderColor: 'rgba(168, 85, 247, 0.3)',
  },
  error: {
    dotBackground: COLORS.error,
    label: 'Error',
    cardBorderColor: 'rgba(255, 0, 80, 0.4)',
  },
  success: {
    dotBackground: COLORS.success,
    label: 'Success',
    cardBorderColor: 'rgba(0, 255, 136, 0.3)',
  },
};

// ── Helper: format ISO or similar timestamp ──────────────────────────
const formatTimestamp = (isoString) => {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString; // fallback to raw
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return isoString;
  }
};

// ── Component ─────────────────────────────────────────────────────────
const LogEntry = ({ log }) => {
  // Safety: handle missing/incomplete props gracefully
  const {
    timestamp = '',
    message = '',
    level = 'info',
  } = log || {};

  const levelStyle = LEVEL_STYLES[level] || LEVEL_STYLES.info;
  const formattedTime = formatTimestamp(timestamp);

  return (
    <article
      role="log"
      aria-live="polite"
      aria-label={`${levelStyle.label} log entry`}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '12px 16px',
        marginBottom: '8px',
        borderRadius: '10px',
        background: 'rgba(26, 26, 46, 0.65)',      // surface with transparency
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: `1px solid ${levelStyle.cardBorderColor}`,
        boxShadow: `0 0 6px ${levelStyle.cardBorderColor.replace(/0\.\d+\)/, '0.1)')}`,
        fontFamily: "'Inter', 'system-ui', sans-serif",
        fontSize: '0.9375rem',
        lineHeight: '1.5',
        color: COLORS.text,
        transition: 'border-color 0.25s, box-shadow 0.25s',
        // Subtle hover lift (optional micro‑interaction)
        cursor: 'default',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = levelStyle.dotBackground;
        e.currentTarget.style.boxShadow = `0 0 12px ${levelStyle.dotBackground}40`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = levelStyle.cardBorderColor;
        e.currentTarget.style.boxShadow = `0 0 6px ${levelStyle.cardBorderColor.replace(/0\.\d+\)/, '0.1)')}`;
      }}
    >
      {/* ── Level indicator dot ───────────────────────────── */}
      <span
        aria-hidden="true"
        style={{
          flexShrink: 0,
          width: '10px',
          height: '10px',
          borderRadius: '50%',
          backgroundColor: levelStyle.dotBackground,
          marginTop: '6px',
          boxShadow: `0 0 8px ${levelStyle.dotBackground}60`,
        }}
      />

      {/* ── Content ───────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header: level label + timestamp */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '4px',
          }}
        >
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: levelStyle.dotBackground,
            }}
          >
            {levelStyle.label}
          </span>
          <time
            dateTime={timestamp}
            style={{
              fontSize: '0.8125rem',
              color: COLORS.textMuted,
              whiteSpace: 'nowrap',
            }}
          >
            {formattedTime}
          </time>
        </div>

        {/* Message */}
        <p
          style={{
            margin: 0,
            fontSize: '0.9375rem',
            lineHeight: '1.5',
            wordBreak: 'break-word',
            color: COLORS.text,
          }}
        >
          {message}
        </p>
      </div>
    </article>
  );
};

export default LogEntry;
```