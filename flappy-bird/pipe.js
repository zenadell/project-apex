/**
 * pipe.js - Pipe Class
 * Manages pipe pairs (top and bottom), movement, collision, and procedural drawing.
 */
import {
    PIPE_WIDTH, PIPE_GAP, PIPE_SPEED,
    PIPE_MIN_HEIGHT, CANVAS_HEIGHT, GROUND_HEIGHT,
    COLORS, SCORE_PER_PIPE,
} from './constants.js';
import { randomInt } from './utils.js';

/**
 * Factory function to create a pipe pair at a given x position.
 * @param {number} x - The x position for the new pipe pair.
 * @returns {{x: number, topHeight: number, bottomY: number, scored: boolean}}
 */
export function createPipePair(x) {
    const topHeight = randomInt(PIPE_MIN_HEIGHT, CANVAS_HEIGHT - GROUND_HEIGHT - PIPE_GAP - PIPE_MIN_HEIGHT);
    const bottomY = topHeight + PIPE_GAP;

    return {
        x,
        topHeight,
        bottomY,
        scored: false,
    };
}

export class PipeManager {
    constructor() {
        this.pipes = [];
        this.width = PIPE_WIDTH;
        this.speed = PIPE_SPEED;
        this.score = 0;
    }

    reset() {
        this.pipes = [];
        this.score = 0;
    }

    /**
     * Add a new pipe pair at the right edge of the canvas.
     */
    addPipe(canvasWidth) {
        this.pipes.push(createPipePair(canvasWidth));
    }

    /**
     * Update all pipes: move left, remove off-screen ones.
     * @param {Function} onScore - Callback when a pipe is scored.
     */
    update(onScore) {
        for (let i = this.pipes.length - 1; i >= 0; i--) {
            const pipe = this.pipes[i];
            pipe.x -= this.speed;

            // Remove pipes that have scrolled off the left
            if (pipe.x + this.width < 0) {
                this.pipes.splice(i, 1);
            }

            // Score tracking (observer pattern — callback)
            if (onScore && !pipe.scored && pipe.x + this.width < 80) {
                pipe.scored = true;
                this.score += SCORE_PER_PIPE;
                onScore(this.score);
            }
        }
    }

    /**
     * Get all pipe rectangles for collision detection.
     * Returns an array of {x, y, width, height}.
     * @returns {Array<{x: number, y: number, width: number, height: number}>}
     */
    getCollisionRects() {
        const rects = [];
        for (const pipe of this.pipes) {
            // Top pipe
            rects.push({
                x: pipe.x,
                y: 0,
                width: this.width,
                height: pipe.topHeight,
            });
            // Bottom pipe
            rects.push({
                x: pipe.x,
                y: pipe.bottomY,
                width: this.width,
                height: CANVAS_HEIGHT - pipe.bottomY - GROUND_HEIGHT,
            });
        }
        return rects;
    }

    /**
     * Draw all pipe pairs.
     * @param {CanvasRenderingContext2D} ctx
     */
    draw(ctx) {
        for (const pipe of this.pipes) {
            this._drawPipe(ctx, pipe.x, 0, this.width, pipe.topHeight, true);
            this._drawPipe(ctx, pipe.x, pipe.bottomY, this.width, CANVAS_HEIGHT - pipe.bottomY - GROUND_HEIGHT, false);
        }
    }

    /**
     * Draw a single pipe segment with procedural details.
     * @private
     */
    _drawPipe(ctx, x, y, w, h, isTop) {
        if (h <= 0) return;

        ctx.save();

        // Main pipe body
        ctx.fillStyle = COLORS.pipe;
        ctx.fillRect(x, y, w, h);

        // Darker edge/border on both sides
        ctx.fillStyle = COLORS.pipeDark;
        ctx.fillRect(x, y, 4, h);
        ctx.fillRect(x + w - 4, y, 4, h);

        // Highlight stripe down the middle
        ctx.fillStyle = COLORS.pipeHighlight;
        ctx.fillRect(x + 8, y, 8, h);

        // Pipe cap (the slightly wider end piece)
        const capHeight = 20;
        const capOverhang = 4;
        const capY = isTop ? y + h - capHeight : y;

        ctx.fillStyle = COLORS.pipe;
        ctx.fillRect(x - capOverhang, capY, w + capOverhang * 2, capHeight);

        // Cap border
        ctx.fillStyle = COLORS.pipeBorder;
        ctx.fillRect(x - capOverhang, capY, w + capOverhang * 2, 3);
        ctx.fillRect(x - capOverhang, capY + capHeight - 3, w + capOverhang * 2, 3);

        // Cap highlight
        ctx.fillStyle = COLORS.pipeHighlight;
        ctx.fillRect(x - capOverhang + 6, capY, 6, capHeight);

        ctx.restore();
    }
}
