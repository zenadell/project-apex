/**
 * utils.js - Utility Functions
 * AABB collision detection and random number generation.
 */

/**
 * Axis-Aligned Bounding Box collision detection.
 * @param {Object} a - Rectangle {x, y, width, height}
 * @param {Object} b - Rectangle {x, y, width, height}
 * @returns {boolean} True if the two rectangles overlap.
 */
export function checkCollision(a, b) {
    return (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
    );
}

/**
 * Generate a random integer between min (inclusive) and max (inclusive).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a random float between min and max.
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randomFloat(min, max) {
    return Math.random() * (max - min) + min;
}

/**
 * Clamp a value between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * Lerp between two values.
 * @param {number} a - Start value
 * @param {number} b - End value
 * @param {number} t - Interpolation factor [0, 1]
 * @returns {number}
 */
export function lerp(a, b, t) {
    return a + (b - a) * t;
}
