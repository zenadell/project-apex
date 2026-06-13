```jsx
/**
 * frontend/src/components/TimeStamp.js
 *
 * Time formatting utility component.
 * Displays a timestamp (ISO string or Unix ms) in a human‑readable format.
 * Automatically updates relative time (e.g., "2m ago") and falls back to
 * absolute time for older timestamps.
 *
 * Styling follows the APEX dark neon design system (glassmorphism, neon glow).
 *
 * Props:
 *   timestamp   – ISO 8601 string or Unix milliseconds number (required)
 *   fullDate    – boolean (optional, default false) – always show absolute time
 *   className   – string (optional) – additional CSS class
 *   style       – object (optional) – additional inline styles
 *
 * Accessibility:
 *   - Renders a <span> with role="timer"
 *   - aria-label provides full readable date/time for screen readers
 *   - Live region respectfully updates via interval
 */

import React, { useState, useEffect, useMemo } from 'react';

// ── Design tokens (from project spec) ──────────────────────────────────────
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

// ── Utility helpers ────────────────────────────────────────────────────────

/**
 * Normalise a timestamp (ISO string or number) to a Date object.
 * Returns null if invalid.
 */
function toDate(timestamp) {
  if (timestamp == null) return null;
  if (typeof timestamp === 'number' || !isNaN(Number(timestamp))) {
    return new Date(Number(timestamp));
  }
  const d = new Date(timestamp);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Format a Date into a relative or absolute string.
 *
 * Rules:
 *  - Less than 60s → "just now"
 *  - Less than 60m → "Xm ago"
 *  - Less than 24h → "Xh ago"
 *  - Less than 7d  → "Xd ago"
 *  - Otherwise → absolute date: "Jan 15, 10:30:45 AM"
 *
 * @param {Date} date
 * @param {boolean} fullDate – if true, always return absolute format
 * @returns {{ relative: string, absolute: string }}
 */
function formatTime(date, fullDate = false) {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  const absolute = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  if (fullDate) {
    return { relative: absolute, absolute };
  }

  let relative;
  if (diffSec < 60) {
    relative = 'just now';
  } else if (diffSec < 3600) {
    relative = `${Math.floor(diffSec / 60)}m ago`;
  } else if (diffSec < 86400) {
    relative = `${Math.floor(diffSec / 3600)}h ago`;
  } else if (diffSec < 604800) {
    relative = `${Math.floor(diffSec / 86400)}d ago`;
  } else {
    relative = absolute;
  }

  return { relative, absolute };
}

// ── Default refresh interval (1 minute) ───────────────────────────────────
const TICK_INTERVAL = 60_000;

const TimeStamp = ({ timestamp, fullDate = false, className, style }) => {
  const [tick, setTick] = useState(0);

  // Force re‑render every TICK_INTERVAL to update relative time
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), TICK_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  const formatted = useMemo(() => {
    const date = toDate(timestamp);
    if (!date) {
      return { relative: '—', absolute: '—' };
    }
    return formatTime(date, fullDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timestamp, fullDate, tick]);

  const displayText = fullDate ? formatted.absolute : formatted.relative;

  return (
    <span
      role="timer"
      aria-label={`Timestamp: ${formatted.absolute}`}
      className={className}
      style={{
        fontFamily: "'Inter', 'system-ui', sans-serif",
        fontSize: '0.8rem',
        color: colors.textMuted,
        background: 'transparent',
        border: 'none',
        padding: 0,
        ...style,
      }}
    >
      {displayText}
    </span>
  );
};

export default TimeStamp;
```