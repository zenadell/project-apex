```jsx
/**
 * frontend/src/context/WebSocketContext.js
 *
 * APEX Dark Neon Design System – WebSocket Context
 * -------------------------------------------------
 * Provides a global WebSocket state and dispatch mechanism.
 * Manages connection lifecycle, automatic reconnection with
 * exponential backoff, and exposes actions for connect/disconnect/send.
 *
 * Usage:
 *   import { WebSocketProvider, useWebSocketContext } from './WebSocketContext';
 *
 *   const { state, dispatch, connect, send } = useWebSocketContext();
 */

import React, { createContext, useContext, useReducer, useCallback, useRef, useEffect } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Initial reconnection delay (ms) */
const INITIAL_RECONNECT_DELAY = 1000;
/** Maximum reconnection delay (ms) to cap exponential backoff */
const MAX_RECONNECT_DELAY = 30000;
/** Backoff multiplier */
const BACKOFF_MULTIPLIER = 2;
/** Number of reconnection attempts before giving up (0 = infinite) */
const MAX_RECONNECT_ATTEMPTS = 0; // 0 means infinite

// ---------------------------------------------------------------------------
// Action Types
// ---------------------------------------------------------------------------

const Actions = {
  CONNECT: 'CONNECT',
  DISCONNECT: 'DISCONNECT',
  SET_STATUS: 'SET_STATUS',
  RECEIVE_MESSAGE: 'RECEIVE_MESSAGE',
  SET_RECONNECT_ATTEMPT: 'SET_RECONNECT_ATTEMPT',
  RESET_RECONNECT_ATTEMPT: 'RESET_RECONNECT_ATTEMPT',
};

// ---------------------------------------------------------------------------
// State Shape & Initial State
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WebSocketState
 * @property {'disconnected'|'connecting'|'connected'|'reconnecting'} status
 * @property {Array<Object>} messages          - Incoming messages (newest first)
 * @property {string|null} url                 - The WebSocket endpoint
 * @property {number} reconnectAttempt         - Current attempt count
 * @property {number|null} reconnectDelay      - Current delay before next attempt
 */

/** @type {WebSocketState} */
const initialState = {
  status: 'disconnected',
  messages: [],
  url: null,
  reconnectAttempt: 0,
  reconnectDelay: null,
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * @param {WebSocketState} state
 * @param {{type: string, payload?: any}} action
 * @returns {WebSocketState}
 */
function webSocketReducer(state, action) {
  switch (action.type) {
    case Actions.CONNECT:
      return {
        ...state,
        status: 'connecting',
        url: action.payload,
      };

    case Actions.DISCONNECT:
      return {
        ...state,
        status: 'disconnected',
        url: null,
        reconnectAttempt: 0,
        reconnectDelay: null,
      };

    case Actions.SET_STATUS:
      return {
        ...state,
        status: action.payload,
      };

    case Actions.RECEIVE_MESSAGE:
      return {
        ...state,
        messages: [action.payload, ...state.messages],
      };

    case Actions.SET_RECONNECT_ATTEMPT:
      return {
        ...state,
        reconnectAttempt: state.reconnectAttempt + 1,
        reconnectDelay: Math.min(
          INITIAL_RECONNECT_DELAY * Math.pow(BACKOFF_MULTIPLIER, state.reconnectAttempt),
          MAX_RECONNECT_DELAY
        ),
        status: 'reconnecting',
      };

    case Actions.RESET_RECONNECT_ATTEMPT:
      return {
        ...state,
        reconnectAttempt: 0,
        reconnectDelay: null,
      };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const WebSocketContext = createContext(null);

// ---------------------------------------------------------------------------
// Provider Component
// ---------------------------------------------------------------------------

/**
 * WebSocketProvider – wraps your app and manages a single WebSocket lifecycle.
 *
 * Props:
 * @param {Object} props
 * @param {React.ReactNode} props.children
 */
export function WebSocketProvider({ children }) {
  const [state, dispatch] = useReducer(webSocketReducer, initialState);

  // Keep a mutable ref for the WebSocket instance
  const wsRef = useRef(null);
  // Keep a ref to the reconnection timeout ID
  const reconnectTimeoutRef = useRef(null);

  // ------------------------------ Connect ----------------------------------

  const connect = useCallback((url) => {
    if (wsRef.current) {
      wsRef.current.close();
      clearTimeout(reconnectTimeoutRef.current);
    }

    dispatch({ type: Actions.CONNECT, payload: url });

    try {
      const socket = new WebSocket(url);
      wsRef.current = socket;

      socket.onopen = () => {
        dispatch({ type: Actions.SET_STATUS, payload: 'connected' });
        dispatch({ type: Actions.RESET_RECONNECT_ATTEMPT });
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          dispatch({ type: Actions.RECEIVE_MESSAGE, payload: data });
        } catch {
          // If not JSON, just dispatch as raw string
          dispatch({ type: Actions.RECEIVE_MESSAGE, payload: { text: event.data } });
        }
      };

      socket.onerror = (error) => {
        console.error('[WebSocketContext] Error:', error);
      };

      socket.onclose = (event) => {
        // Determine if we should reconnect
        if (!event.wasClean && state.url) {
          // Unexpected close – attempt reconnection
          scheduleReconnect();
        } else {
          // Clean close (disconnect initiated by user)
          dispatch({ type: Actions.DISCONNECT });
        }
      };
    } catch (error) {
      console.error('[WebSocketContext] Connection failed:', error);
      dispatch({ type: Actions.DISCONNECT });
    }
  }, [state.url]);

  // ------------------------------ Reconnect ---------------------------------

  const scheduleReconnect = useCallback(() => {
    if (MAX_RECONNECT_ATTEMPTS > 0 && state.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[WebSocketContext] Max reconnect attempts reached. Stopping.');
      dispatch({ type: Actions.DISCONNECT });
      return;
    }

    dispatch({ type: Actions.SET_RECONNECT_ATTEMPT });

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(BACKOFF_MULTIPLIER, state.reconnectAttempt),
      MAX_RECONNECT_DELAY
    );

    console.info(`[WebSocketContext] Reconnecting in ${delay}ms (attempt ${state.reconnectAttempt + 1})`);

    reconnectTimeoutRef.current = setTimeout(() => {
      if (state.url) {
        connect(state.url);
      }
    }, delay);
  }, [state.reconnectAttempt, state.url, connect]);

  // ------------------------------ Disconnect --------------------------------

  const disconnect = useCallback(() => {
    clearTimeout(reconnectTimeoutRef.current);
    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnect');
      wsRef.current = null;
    }
    dispatch({ type: Actions.DISCONNECT });
  }, []);

  // ------------------------------ Send Message ------------------------------

  const send = useCallback((data) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(typeof data === 'string' ? data : JSON.stringify(data));
    } else {
      console.warn('[WebSocketContext] Cannot send – socket not open');
    }
  }, []);

  // ------------------------------ Cleanup on unmount -------------------------

  useEffect(() => {
    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmount');
      }
    };
  }, []);

  // ------------------------------ Context Value -----------------------------

  const contextValue = {
    state,
    dispatch,
    connect,
    disconnect,
    send,
  };

  return (
    <WebSocketContext.Provider value={contextValue}>
      {children}
    </WebSocketContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * useWebSocketContext – access WebSocket state and actions within any component.
 * Must be used inside a <WebSocketProvider>.
 *
 * @returns {{
 *   state: WebSocketState,
 *   dispatch: Function,
 *   connect: (url: string) => void,
 *   disconnect: () => void,
 *   send: (data: string|Object) => void,
 * }}
 */
export function useWebSocketContext() {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocketContext must be used within a WebSocketProvider');
  }
  return context;
}
```