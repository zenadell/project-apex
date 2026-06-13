```javascript
/**
 * frontend/src/hooks/useWebSocket.js
 *
 * APEX Dark Neon Design System – WebSocket Hook
 * ----------------------------------------------
 * Custom React hook for managing WebSocket connections with exponential
 * backoff reconnection logic. Returns connection status, send/connect/disconnect
 * functions, and integrates seamlessly with the glassmorphism UI.
 *
 * Features:
 *   - Automatic reconnection with exponential backoff (with optional jitter)
 *   - Configurable maximum retries (default infinite)
 *   - Full cleanup on unmount or URL change
 *   - Callback-based message/event handling
 *   - Connection status state machine: disconnected → connecting → connected
 *     → (error/close) → reconnecting → connecting …
 *
 * @param {string} url - WebSocket server URL
 * @param {object} [options]
 * @param {function} [options.onMessage] - Called with message data when received
 * @param {function} [options.onOpen]    - Called when connection opens
 * @param {function} [options.onClose]   - Called when connection closes (event)
 * @param {function} [options.onError]   - Called when an error occurs
 * @param {boolean} [options.reconnect=true] - Enable automatic reconnection
 * @param {number}  [options.maxRetries=Infinity] - Maximum reconnection attempts
 * @param {number}  [options.initialBackoff=1000] - Initial backoff delay in ms
 * @param {number}  [options.maxBackoff=30000]    - Maximum backoff delay in ms
 * @returns {{ status: string, send: function, connect: function, disconnect: function }}
 */

import { useRef, useState, useEffect, useCallback } from 'react';

const DEFAULT_INITIAL_BACKOFF = 1000;   // 1 second
const DEFAULT_MAX_BACKOFF = 30000;       // 30 seconds

const useWebSocket = (url, options = {}) => {
  const {
    onMessage,
    onOpen,
    onClose,
    onError,
    reconnect = true,
    maxRetries = Infinity,
    initialBackoff = DEFAULT_INITIAL_BACKOFF,
    maxBackoff = DEFAULT_MAX_BACKOFF,
  } = options;

  // Connection status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
  const [status, setStatus] = useState('disconnected');

  // Refs to hold mutable state without causing re-renders
  const wsRef = useRef(null);
  const retryCountRef = useRef(0);
  const timeoutRef = useRef(null);
  const mountedRef = useRef(false);

  /**
   * Calculate the next backoff delay with optional jitter to prevent
   * thundering herd problems across multiple clients.
   * Formula: delay = min(initialBackoff * 2^attempt, maxBackoff)
   * Jitter adds ±25% randomness.
   */
  const getBackoffDelay = useCallback(
    (attempt) => {
      const exponentialDelay = Math.min(
        initialBackoff * Math.pow(2, attempt),
        maxBackoff
      );
      // Add ±25% jitter
      const jitter = exponentialDelay * (0.75 + Math.random() * 0.5);
      return Math.round(jitter);
    },
    [initialBackoff, maxBackoff]
  );

  /**
   * Create and open a new WebSocket connection.
   * Resets retry count on successful open.
   */
  const connect = useCallback(() => {
    if (!url) {
      console.warn('[useWebSocket] No URL provided – cannot connect.');
      return;
    }

    // Prevent duplicate connections
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return;
    }

    setStatus('connecting');

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setStatus('connected');
      retryCountRef.current = 0; // Reset retry count on successful connection
      if (onOpen) onOpen();
    };

    ws.onclose = (event) => {
      if (!mountedRef.current) return;
      setStatus('disconnected');
      wsRef.current = null;

      if (onClose) onClose(event);

      // Schedule reconnection if enabled and within retry limit
      if (reconnect && retryCountRef.current < maxRetries) {
        const attempt = retryCountRef.current;
        const delay = getBackoffDelay(attempt);
        retryCountRef.current += 1;

        setStatus('reconnecting');
        timeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            connect();
          }
        }, delay);
      }
    };

    ws.onerror = (error) => {
      if (!mountedRef.current) return;
      if (onError) onError(error);
      // The onclose handler will fire after an error, so reconnection is handled there
    };

    ws.onmessage = (event) => {
      if (mountedRef.current && onMessage) {
        onMessage(event.data);
      }
    };
  }, [url, reconnect, maxRetries, getBackoffDelay, onMessage, onOpen, onClose, onError]);

  /**
   * Send data over the WebSocket connection.
   * Logs a warning if the connection is not open.
   */
  const send = useCallback((data) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    } else {
      console.warn('[useWebSocket] Cannot send – WebSocket is not connected.');
    }
  }, []);

  /**
   * Manually close the connection and clear any pending reconnection.
   */
  const disconnect = useCallback(() => {
    clearTimeout(timeoutRef.current);
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus('disconnected');
  }, []);

  // Establish connection when the component mounts or URL changes
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      clearTimeout(timeoutRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, connect]);

  return { status, send, connect, disconnect };
};

export default useWebSocket;
```