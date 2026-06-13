```jsx
/**
 * frontend/src/components/LogFeed.js
 *
 * Log feed container component.
 * Displays a glassmorphism card containing a scrollable list of log entries
 * with a "Clear All" action button. Designed for the APEX dark neon design system.
 *
 * @param {Object[]} logs - Array of log objects, each with:
 *   - timestamp: string (ISO or formatted)
 *   - message: string
 *   - level: 'info' | 'warn' | 'error' (optional)
 * @param {Function} onClear - Callback to clear all logs.
 * @param {string} [className] - Additional CSS class names.
 */

import React, { useRef, useEffect } from 'react';

// --- Color tokens for log levels ---
const levelColors = {
  info: { text: '#00d4ff', background: 'rgba(0, 212, 255, 0.08)' },
  warn: { text: '#a855f7', background: 'rgba(168, 85, 247, 0.08)' },
  error: { text: '#ff0050', background: 'rgba(255, 0, 80, 0.08)' },
};

const defaultLevel = 'info';

// --- Base styles (glassmorphism card) ---
const containerStyle = {
  background: 'rgba(26, 26, 46, 0.7)',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  border: '1px solid rgba(42, 42, 62, 0.6)',
  borderRadius: '16px',
  padding: '20px',
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 0 60px rgba(0, 212, 255, 0.02)',
  color: '#e0e0e0',
  fontFamily: "'Inter', 'system-ui', sans-serif",
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: '200px',
  position: 'relative',
  overflow: 'hidden',
};

// Subtle noise texture via pseudo‑element – applied via a `<style>` block
const noiseStyles = `
  .log-feed-card::before {
    content: '';
    position: absolute;
    inset: 0;
    background: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 1;
    mix-blend-mode: overlay;
  }
  .log-feed-card {
    position: relative;
  }
  .log-feed-card > * {
    position: relative;
    z-index: 2;
  }
  .log-item:hover {
    background: rgba(42, 42, 62, 0.6) !important;
    transition: background 0.2s ease;
  }
  .clear-btn:hover {
    filter: brightness(1.2);
    transform: scale(1.02);
  }
  .clear-btn:active {
    transform: scale(0.98);
  }
`;

const headerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '12px',
};

const titleStyle = {
  fontSize: '16px',
  fontWeight: 600,
  letterSpacing: '0.02em',
  color: '#e0e0e0',
  margin: 0,
  textTransform: 'uppercase',
};

const clearBtnStyle = {
  background: 'rgba(255, 0, 80, 0.15)',
  border: '1px solid rgba(255, 0, 80, 0.3)',
  borderRadius: '8px',
  color: '#ff0050',
  padding: '6px 16px',
  fontSize: '13px',
  fontWeight: 500,
  cursor: 'pointer',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  transition: 'all 0.2s ease',
  outline: 'none',
  boxShadow: '0 0 8px rgba(255, 0, 80, 0.1)',
};

const listContainerStyle = {
  flex: 1,
  overflowY: 'auto',
  maxHeight: '400px',
  marginRight: '-8px',
  paddingRight: '8px',
  scrollBehavior: 'smooth',
};

const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const logItemStyle = (level = defaultLevel) => ({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '10px',
  padding: '8px 12px',
  background: levelColors[level]?.background || levelColors[defaultLevel].background,
  borderRadius: '8px',
  borderLeft: `3px solid ${levelColors[level]?.text || levelColors[defaultLevel].text}`,
  boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
  transition: 'background 0.15s ease',
  cursor: 'default',
  fontSize: '13px',
  lineHeight: 1.5,
  wordBreak: 'break-word',
});

const timestampStyle = {
  color: '#888',
  fontSize: '12px',
  whiteSpace: 'nowrap',
  flexShrink: 0,
  marginTop: '1px',
};

const messageStyle = {
  color: '#e0e0e0',
  flex: 1,
};

const emptyStyle = {
  textAlign: 'center',
  color: '#888',
  padding: '40px 20px',
  fontStyle: 'italic',
  fontSize: '14px',
};

// --- Component ---
const LogFeed = ({ logs = [], onClear, className = '' }) => {
  const listRef = useRef(null);
  const shouldAutoScroll = useRef(true);

  // Auto‑scroll to bottom when new logs arrive, unless user scrolled up
  useEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;

    const isAtBottom = listEl.scrollHeight - listEl.scrollTop <= listEl.clientHeight + 30;
    if (isAtBottom && logs.length > 0) {
      listEl.scrollTop = listEl.scrollHeight;
    }
  }, [logs]);

  // Mark auto‑scroll should stop when user scrolls up
  const handleScroll = () => {
    const listEl = listRef.current;
    if (!listEl) return;
    const isAtBottom = listEl.scrollHeight - listEl.scrollTop <= listEl.clientHeight + 30;
    shouldAutoScroll.current = isAtBottom;
  };

  // Format timestamp to short local time
  const formatTime = (ts) => {
    try {
      const date = new Date(ts);
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return ts;
    }
  };

  return (
    <>
      <style>{noiseStyles}</style>
      <div className={`log-feed-card ${className}`} style={containerStyle} role="log" aria-live="polite" aria-label="Log feed">
        <div style={headerStyle}>
          <h3 style={titleStyle}>Log Feed</h3>
          {logs.length > 0 && (
            <button
              className="clear-btn"
              style={clearBtnStyle}
              onClick={onClear}
              aria-label="Clear all logs"
            >
              Clear All
            </button>
          )}
        </div>

        <div
          ref={listRef}
          style={listContainerStyle}
          onScroll={handleScroll}
        >
          {logs.length === 0 ? (
            <div style={emptyStyle}>No logs yet.</div>
          ) : (
            <ul style={listStyle}>
              {logs.map((log, index) => {
                const level = log.level || defaultLevel;
                return (
                  <li
                    key={index}
                    className="log-item"
                    style={logItemStyle(level)}
                  >
                    <span style={timestampStyle}>{formatTime(log.timestamp)}</span>
                    <span style={messageStyle}>{log.message}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
};

export default LogFeed;
```