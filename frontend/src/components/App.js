```jsx
/**
 * frontend/src/components/App.js
 *
 * Root React component for the APEX terminal feed.
 * Wraps the entire application in a WebSocket context (provider)
 * that handles connection lifecycle, auto‑reconnect with exponential backoff,
 * and maintains a live log feed.
 *
 * Design:
 *  - Dark glassmorphism surface with neon accents
 *  - Semi‑transparent backdrop blur cards
 *  - Layered depth, micro‑interactions, subtle noise overlay
 *  - Fully accessible with ARIA attributes
 */

import React, { useState, useEffect, useCallback, useContext, useRef } from 'react';

// ---------------------------------------------------------------------------
// WebSocket Context & Provider (inline for self‑containment)
// ---------------------------------------------------------------------------

const WebSocketContext = React.createContext({
  logs: [],
  status: 'disconnected',
  send: () => {},
  reconnectAttempt: 0,
});

export function useWebSocket() {
  const ctx = useContext(WebSocketContext);
  if (!ctx) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return ctx;
}

/**
 * WebSocketProvider
 * - Connects to ws://localhost:8080/ws (override via WEBSOCKET_URL env var)
 * - Maintains connection status: 'connecting' | 'connected' | 'disconnected'
 * - Auto‑reconnect with exponential backoff (1s, 2s, 4s, … up to 30s)
 * - Collects incoming messages into a log array (max 500 entries)
 * - Exposes a `send` function and the current log array
 */
export function WebSocketProvider({ children, url }) {
  const [logs, setLogs] = useState([]);
  const [status, setStatus] = useState('disconnected');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const wsRef = useRef(null);
  const timerRef = useRef(null);

  const connect = useCallback(() => {
    const endpoint = url || process.env.REACT_APP_WS_URL || 'ws://localhost:8080/ws';
    console.log(`[WS] Connecting to ${endpoint} (attempt ${reconnectAttempt + 1})`);
    setStatus('connecting');

    const ws = new WebSocket(endpoint);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connected');
      setStatus('connected');
      setReconnectAttempt(0);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        setLogs((prev) =>
          [{ timestamp: new Date().toISOString(), data: msg }, ...prev].slice(0, 500)
        );
      } catch {
        // Plain text messages
        setLogs((prev) =>
          [{ timestamp: new Date().toISOString(), data: { text: event.data } }, ...prev].slice(0, 500)
        );
      }
    };

    ws.onerror = (err) => {
      console.error('[WS] Error', err);
    };

    ws.onclose = (event) => {
      console.log(`[WS] Closed (code=${event.code})`);
      setStatus('disconnected');
      wsRef.current = null;

      // Exponential backoff: 1s, 2s, 4s … capped at 30s
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
      console.log(`[WS] Reconnecting in ${delay / 1000}s`);
      timerRef.current = setTimeout(() => {
        setReconnectAttempt((prev) => prev + 1);
      }, delay);
    };
  }, [reconnectAttempt, url]);

  // Initial connection
  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [connect]);

  const send = useCallback((data) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(typeof data === 'string' ? data : JSON.stringify(data));
    } else {
      console.warn('[WS] Cannot send – not connected');
    }
  }, []);

  const value = { logs, status, send, reconnectAttempt };
  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Design Tokens (matching specification)
// ---------------------------------------------------------------------------

const tokens = {
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
  fontFamily: "'Inter', 'system-ui', sans-serif",
};

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

/**
 * StatusDot – shows current connection state with animated glow
 */
function StatusDot({ status }) {
  const colorMap = {
    connected: tokens.success,
    connecting: tokens.primary,
    disconnected: tokens.error,
  };
  return (
    <span
      className="status-dot"
      style={{
        display: 'inline-block',
        width: 12,
        height: 12,
        borderRadius: '50%',
        backgroundColor: colorMap[status] || tokens.textMuted,
        boxShadow: `0 0 8px ${colorMap[status] || tokens.textMuted}`,
        transition: 'background-color 0.3s, box-shadow 0.3s',
        animation: status === 'connecting' ? 'pulse 1.5s infinite' : 'none',
      }}
      aria-label={`Connection status: ${status}`}
    />
  );
}

/**
 * LogFeed – scrollable glassmorphism list of incoming log entries
 */
function LogFeed({ logs }) {
  const feedRef = useRef(null);

  useEffect(() => {
    // Auto‑scroll to top (newest first)
    if (feedRef.current) {
      feedRef.current.scrollTop = 0;
    }
  }, [logs]);

  if (logs.length === 0) {
    return (
      <div className="log-feed-empty" style={{
        color: tokens.textMuted,
        fontStyle: 'italic',
        padding: '2rem',
        textAlign: 'center',
      }}>
        ⏳ Waiting for events…
      </div>
    );
  }

  return (
    <div
      ref={feedRef}
      className="log-feed"
      style={{
        maxHeight: '60vh',
        overflowY: 'auto',
        padding: '0.5rem',
      }}
      role="log"
      aria-live="polite"
      aria-label="Live log feed"
    >
      {logs.map((entry, idx) => (
        <div
          key={entry.timestamp + '-' + idx}
          className="log-entry"
          style={{
            padding: '0.5rem 0.75rem',
            marginBottom: '0.25rem',
            background: 'rgba(26, 26, 46, 0.6)',
            backdropFilter: 'blur(4px)',
            borderRadius: 8,
            border: '1px solid rgba(42, 42, 62, 0.5)',
            fontSize: '0.85rem',
            color: tokens.text,
            transition: 'background 0.2s, border-color 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(26, 26, 46, 0.8)';
            e.currentTarget.style.borderColor = tokens.primary;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(26, 26, 46, 0.6)';
            e.currentTarget.style.borderColor = 'rgba(42, 42, 62, 0.5)';
          }}
        >
          <span style={{ color: tokens.textMuted, marginRight: 8 }}>
            {new Date(entry.timestamp).toLocaleTimeString()}
          </span>
          <span style={{ color: tokens.primary }}>
            {typeof entry.data === 'object' ? JSON.stringify(entry.data, null, 1) : entry.data.text || entry.data}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * ConnectionIndicator – shows dot + text + reconnect attempt info
 */
function ConnectionIndicator({ status, reconnectAttempt }) {
  const labelMap = {
    connected: 'Connected',
    connecting: 'Connecting…',
    disconnected: 'Disconnected',
  };
  return (
    <div
      className="connection-indicator"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0.75rem 1rem',
        background: 'rgba(26, 26, 46, 0.7)',
        backdropFilter: 'blur(10px)',
        borderRadius: 12,
        border: '1px solid rgba(42, 42, 62, 0.6)',
        marginBottom: '1rem',
      }}
    >
      <StatusDot status={status} />
      <span style={{ color: tokens.text, fontWeight: 500 }}>
        {labelMap[status] || 'Unknown'}
      </span>
      {reconnectAttempt > 0 && status !== 'connected' && (
        <span style={{ color: tokens.textMuted, fontSize: '0.8rem', marginLeft: 'auto' }}>
          Reconnect #{reconnectAttempt}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App Component
// ---------------------------------------------------------------------------

export default function App() {
  const { logs, status, send, reconnectAttempt } = useWebSocket();

  // Keep a simple counter for demo sending (optional)
  const [counter, setCounter] = useState(0);

  const handleSendTest = () => {
    send({ type: 'ping', payload: `ping #${counter + 1}` });
    setCounter((c) => c + 1);
  };

  return (
    <div
      className="app-root"
      style={{
        minHeight: '100vh',
        background: tokens.background,
        color: tokens.text,
        fontFamily: tokens.fontFamily,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Noise texture overlay */}
      <div
        className="noise-overlay"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          opacity: 0.03,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          backgroundSize: '256px 256px',
          zIndex: 9999,
        }}
      />

      {/* Main glassmorphism card */}
      <div
        className="main-card"
        style={{
          maxWidth: 900,
          margin: '2rem auto',
          padding: '1.5rem',
          background: 'rgba(26, 26, 46, 0.55)',
          backdropFilter: 'blur(16px)',
          borderRadius: 24,
          border: '1px solid rgba(255, 255, 255, 0.08)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Header */}
        <header
          className="app-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '1rem',
            padding: '0 0.25rem',
          }}
        >
          <h1
            style={{
              fontSize: '1.8rem',
              fontWeight: 700,
              background: `linear-gradient(135deg, ${tokens.primary}, ${tokens.secondary})`,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '0.02em',
              margin: 0,
            }}
          >
            APEX · Terminal Feed
          </h1>
          <button
            onClick={handleSendTest}
            disabled={status !== 'connected'}
            style={{
              background: `linear-gradient(135deg, ${tokens.primary}, ${tokens.secondary})`,
              color: '#fff',
              border: 'none',
              padding: '0.5rem 1.2rem',
              borderRadius: 12,
              fontWeight: 600,
              cursor: status === 'connected' ? 'pointer' : 'not-allowed',
              opacity: status === 'connected' ? 1 : 0.5,
              backdropFilter: 'blur(4px)',
              boxShadow: `0 0 12px ${tokens.primary}40`,
              transition: 'all 0.2s',
              fontSize: '0.9rem',
            }}
            onMouseEnter={(e) => {
              if (status === 'connected') {
                e.target.style.boxShadow = `0 0 20px ${tokens.primary}80`;
              }
            }}
            onMouseLeave={(e) => {
              e.target.style.boxShadow = `0 0 12px ${tokens.primary}40`;
            }}
          >
            Send Test Ping
          </button>
        </header>

        {/* Connection indicator */}
        <ConnectionIndicator status={status} reconnectAttempt={reconnectAttempt} />

        {/* Log feed */}
        <div
          className="feed-wrapper"
          style={{
            background: 'rgba(10, 10, 15, 0.4)',
            borderRadius: 16,
            border: '1px solid rgba(42, 42, 62, 0.4)',
            overflow: 'hidden',
          }}
        >
          <LogFeed logs={logs} />
        </div>

        {/* Log count footer */}
        <footer
          style={{
            marginTop: '0.75rem',
            fontSize: '0.75rem',
            color: tokens.textMuted,
            textAlign: 'right',
            padding: '0 0.25rem',
          }}
        >
          {logs.length} log entries • {status}
        </footer>
      </div>

      {/* Global keyframes for pulse animation */}
      <style>{`
        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.4; }
          100% { opacity