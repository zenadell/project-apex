```jsx
/**
 * frontend/src/components/NeonGlow.js
 *
 * APEX Dark Neon Design System – NeonGlow Component
 * -------------------------------------------------
 * Wraps children with a configurable neon glow effect.
 * Options: active color, glow intensity, pulse animation.
 * Fully accessible (supports prefers-reduced-motion).
 *
 * Props:
 *   children   – React node(s) to wrap
 *   color      – glow color (default: primary #00d4ff)
 *   intensity  – 'soft' | 'medium' | 'hard' (default: 'medium')
 *   animated   – boolean to enable pulse animation (default: false)
 *   className  – additional CSS classes
 *   style      – additional inline styles
 */

import React from 'react';

const GLOW_INTENSITY = {
  soft: {
    radius: 4,
    spread: 6,
    opacity: 0.4,
  },
  medium: {
    radius: 8,
    spread: 12,
    opacity: 0.6,
  },
  hard: {
    radius: 14,
    spread: 20,
    opacity: 0.8,
  },
};

const NeonGlow = ({
  children,
  color = '#00d4ff',
  intensity = 'medium',
  animated = false,
  className = '',
  style = {},
}) => {
  const { radius, spread, opacity } = GLOW_INTENSITY[intensity] || GLOW_INTENSITY.medium;

  const glowStyle = {
    boxShadow: `
      0 0 ${radius}px ${color}${Math.round(opacity * 100)},
      0 0 ${spread}px ${color}${Math.round(opacity * 80)},
      0 0 ${spread * 1.5}px ${color}${Math.round(opacity * 50)}
    `,
    border: `1px solid ${color}44`,
    borderRadius: '8px',
    transition: 'box-shadow 0.3s ease, border-color 0.3s ease',
    ...(animated && {
      animation: 'neon-pulse 2s infinite ease-in-out',
    }),
  };

  return (
    <div
      className={`neon-glow ${className}`}
      style={{ ...glowStyle, ...style }}
      role="presentation"
    >
      {children}
      <style>{`
        @keyframes neon-pulse {
          0%, 100% {
            box-shadow: ${glowStyle.boxShadow};
            border-color: ${color}44;
          }
          50% {
            box-shadow: 
              0 0 ${radius * 1.5}px ${color},
              0 0 ${spread * 1.8}px ${color},
              0 0 ${spread * 2.5}px ${color};
            border-color: ${color}aa;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .neon-glow {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
};

export default NeonGlow;

// Usage example (inside any component):
// <NeonGlow color="#a855f7" intensity="soft" animated>
//   <span>Live Status</span>
// </NeonGlow>
```