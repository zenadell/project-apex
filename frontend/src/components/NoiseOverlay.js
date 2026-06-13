```jsx
/**
 * frontend/src/components/NoiseOverlay.js
 *
 * APEX Dark Neon Design System – Noise Overlay Component
 * -------------------------------------------------------
 * Renders an extremely subtle, fixed-position SVG noise texture
 * over the entire viewport. Adds grit and visual depth without
 * overwhelming the glassmorphism and neon aesthetic.
 *
 * Props:
 *   opacity   – Number (0.01–0.1), default 0.03
 *   blendMode – String (CSS mix-blend-mode), default 'overlay'
 *   zIndex    – Number, default 9999
 *
 * Accessibility: marked as aria-hidden="true" because it is
 * purely decorative and should not be announced by screen readers.
 *
 * Usage:
 *   import NoiseOverlay from './components/NoiseOverlay';
 *   // Place once at root of app, e.g. inside a wrapper div
 *   <NoiseOverlay opacity={0.04} blendMode="multiply" />
 */

import React from 'react';

const NoiseOverlay = ({ opacity = 0.03, blendMode = 'overlay', zIndex = 9999 }) => {
  const noiseSvg = `
    <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
      <filter id="noiseFilter">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.65"
          numOctaves="3"
          stitchTiles="stitch"
        />
      </filter>
      <rect width="100%" height="100%" filter="url(#noiseFilter)" />
    </svg>
  `;
  
  const encodedSvg = encodeURIComponent(noiseSvg);
  const dataUri = `data:image/svg+xml,${encodedSvg}`;

  const overlayStyle = {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    pointerEvents: 'none',         // allow clicks to pass through
    zIndex,
    opacity,
    mixBlendMode: blendMode,
    backgroundImage: `url("${dataUri}")`,
    backgroundRepeat: 'repeat',
    backgroundSize: '200px 200px', // tile the noise pattern
    willChange: 'transform',       // hint for performance
  };

  return <div style={overlayStyle} aria-hidden="true" />;
};

export default NoiseOverlay;
```