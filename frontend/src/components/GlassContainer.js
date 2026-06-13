```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>APEX Log Feed</title>
  <style>
    :root {
      --primary: #00d4ff;
      --secondary: #a855f7;
      --accent: #ff0050;
      --background: #0a0a0f;
      --surface: #1a1a2e;
      --text: #e0e0e0;
      --text-muted: #888;
      --border: #2a2a3e;
      --error: #ff0050;
      --success: #00ff88;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Inter', 'system-ui', sans-serif;
      background: var(--background);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }

    #root {
      width: 100%;
      max-width: 800px;
      height: 90vh;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    /* Glassmorphism base */
    .glass {
      background: rgba(26, 26, 46, 0.4);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(42, 42, 62, 0.6);
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }

    /* Noise overlay (applied after glass) */
    .noise::before {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
      background-repeat: repeat;
      background-size: 200px 200px;
      opacity: 0.35;
      mix-blend-mode: overlay;
    }

    .glass-container {
      position: relative;
      padding: 1.5rem;
    }

    /* Cards for log entries */
    .log-entry {
      position: relative;
      padding: 1rem;
      margin-bottom: 0.75rem;
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      cursor: default;
    }

    .log-entry:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(0, 212, 255, 0.1);
    }

    .log-level-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 6px;
    }

    .log-level-dot.info {
      background: var(--primary);
      box-shadow: 0 0 6px var(--primary);
    }
    .log-level-dot.warn {
      background: #f59e0b;
      box-shadow: 0 0 6px #f59e0b;
    }
    .log-level-dot.error {
      background: var(--error);
      box-shadow: 0 0 6px var(--error);
    }
    .log-level-dot.success {
      background: var(--success);
      box-shadow: 0 0 6px var(--success);
    }

    .log-content {
      flex: 1;
      min-width: 0;
    }

    .log-message {
      word-break: break-word;
      line-height: 1.5;
    }

    .log-time {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.2rem;
    }

    /* Header / connection bar */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.5rem;
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: var(--text-muted);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      transition: background 0.3s;
    }

    .status-dot.connected {
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
    }
    .status-dot.connecting {
      background: var(--secondary);
      box-shadow: 0 0 8px var(--secondary);
      animation: pulse 1s infinite;
    }
    .status-dot.disconnected {
      background: var(--error);
      box-shadow: 0 0 8px var(--error);
    }
    .status-dot.error {
      background: #f59e0b;
      box-shadow: 0 0 8px #f59e0b;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .log-feed {
      flex: 1;
      overflow-y: auto;
      padding: 0.75rem 0;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }

    .log-feed::-webkit-scrollbar {
      width: 4px;
    }
    .log-feed::-webkit-scrollbar-track {
      background: transparent;
    }
    .log-feed::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 4px;
    }

    .empty-state {
      text-align: center;
      padding: 2rem;
      color: var(--text-muted);
      font-style: italic;
    }

    /* Neon glow utilities */
    .neon-glow {
      box-shadow: 0 0 15px rgba(0, 212, 255, 0.2), 0 0 30px rgba(168, 85, 247, 0.1);
    }

    /* Micro interactions */
    button, .clickable {
      transition: transform 0.1s, box-shadow 0.1s;
    }
    button:active, .clickable:active {
      transform: scale(0.97);
    }

    /* Typography */
    h1, h2, h3 {
      font-weight: 600;
      letter-spacing: -0.02em;
    }

    a {
      color: var(--primary);
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div id="root"></div>

  <!-- React and Babel for JSX -->
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>

  <script type="text/babel">
    const { useState, useEffect, useRef, useCallback, createContext, useContext } = React;

    // ============================================================
    // GlassContainer.js
    // ============================================================
    /**
     * GlassContainer – reusable glassmorphism wrapper.
     * @param {Object} props
     * @param {React.ReactNode} props.children
     * @param {string} [props.className] – additional class names
     * @param {boolean} [props.noise=true] – add noise overlay
     * @param {boolean} [props.neon=false] – neon glow effect
     * @param {string} [props.as='div'] – element type (div, section, article...)
     */
    const GlassContainer = ({ children, className = '', noise = true, neon = false, as: Tag = 'div', ...rest }) => {
      const combinedClassName = [
        'glass',
        noise && 'noise',
        neon && 'neon-glow',
        className
      ].filter(Boolean).join(' ');

      return React.createElement(Tag, { className: combinedClassName, ...rest }, children);
    };

    // ============================================================
    // TimeStamp.js
    // ============================================================
    /**
     * TimeStamp – displays a timestamp with relative/absolute time.
     * @param {Object} props
     * @param {string|number} props.timestamp – ISO string or Unix ms
     * @param {boolean} [props.showFull=false] – force full absolute
     */
    const TimeStamp = ({ timestamp, showFull = false }) => {
      const getTime = useCallback(() => {
        const date = new Date(timestamp);
        if (isNaN(date.getTime())) return 'Invalid date';

        const now = Date.now();
        const diffMs = now - date.getTime();
        const diffSec = Math.floor(diffMs / 1000);

        if (showFull || diffSec > 86400) {
          // older than 24h: absolute
          return date.toLocaleString('en-GB', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });
        }

        if (diffSec < 5) return 'just now';
        if (diffSec < 60) return `${diffSec}s ago`;
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      }, [timestamp, showFull]);

      const [text, setText] = useState(getTime);

      useEffect(() => {
        setText(getTime);
        // update every 30s for relative times
        const interval = setInterval(() => setText(getTime), 30000);
        return () => clearInterval(interval);
      }, [getTime]);

      return React.createElement('span', { className: 'log-time', title: new Date(timestamp).toISOString() }, text);
    };

    // ============================================================
    // LogEntry.js
    // ============================================================
    /**
     * LogEntry – individual log card.
     * @param {Object} props
     * @param {Object} props.log – { timestamp, message, level }
     */
    const LogEntry = ({ log }) => {
      const { timestamp, message, level = 'info' } = log;
      const validLevel = ['info', 'warn', 'error', 'success'].includes(level) ? level : 'info';

      return React.createElement(
        GlassContainer,
        { className: 'log-entry', as: 'article', noise: true },
        React.createElement('span', { className: `log-level-dot ${validLevel}`, 'aria-hidden': 'true' }),
        React.createElement(
          'div',
          { className: 'log-content' },
          React.createElement('p', { className: 'log-message' }, message),
          React.createElement(TimeStamp, { timestamp })
        )
      );
    };

    // ============================================================
    // LogFeed – main app
    // ============================================================
    const LogFeed = () => {
      const [logs, setLogs] = useState([]);
      const [status, setStatus] = useState('disconnected'); // 'disconnected' | 'connecting' | 'connected' | 'error'
      const wsRef = useRef(null);
      const reconnectTimeoutRef = useRef(null);
      const retryCountRef = useRef(0);
      const MAX_RETRIES = 10;
      const BASE_DELAY = 1000;
      const MAX_DELAY = 30000;
      const feedRef = useRef(null);

      const connect = useCallback(() => {
        if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
          return;
        }

        setStatus('connecting');
        const wsUrl = 'ws://localhost:8080/ws'; // adjust as needed

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setStatus('connected');
          retryCountRef.current = 0;
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            // Expect: { timestamp: string, message: string, level: string }
            if (data.message && data.timestamp) {
              setLogs(prev => [...prev, { ...data, level: data.level || 'info' }]);
            }
          } catch {
            // plain text message
            setLogs(prev => [...prev, { timestamp: new Date().toISOString(), message: event.data, level: 'info' }]);
          }
        };

        ws.onerror = () => {
          setStatus('error');
        };

        ws.onclose = (event) => {
          setStatus('disconnected');
          // Exponential backoff reconnect
          if (retryCountRef.current < MAX_RETRIES) {
            const delay = Math.min(BASE_DELAY * Math.pow(2, retryCountRef.current) + Math.random() * 1000, MAX_DELAY);
            retryCountRef.current += 1;
            console.log(`Reconnecting in ${delay}ms (attempt ${retryCountRef.current})`);
            reconnectTimeoutRef.current = setTimeout(connect, delay);
          } else {
            setStatus('error');
          }
        };
      }, []);

      useEffect(() => {
        connect();
        return () => {
          if (wsRef.current) wsRef.current