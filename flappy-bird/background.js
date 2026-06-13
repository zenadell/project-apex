/**
 * background.js - Background Class
 * Handles scrolling ground (parallax effect), sky gradient, and cloud layer.
 */
import {
    CANVAS_WIDTH, CANVAS_HEIGHT,
    GROUND_HEIGHT, GROUND_SCROLL_SPEED,
    COLORS,
} from './constants.js';
import { randomFloat } from './utils.js';

class Cloud {
    constructor() {
        this.reset(true);
    }

    reset(initial) {
        this.x = initial ? randomFloat(0, CANVAS_WIDTH) : CANVAS_WIDTH + 50;
        this.y = randomFloat(20, 120);
        this.width = randomFloat(50, 90);
        this.height = randomFloat(20, 35);
        this.speed = randomFloat(0.2, 0.6);
        this.opacity = randomFloat(0.6, 1.0);
    }

    update() {
        this.x -= this.speed;
        if (this.x + this.width < -50) {
            this.reset(false);
        }
    }

    draw(ctx) {
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.fillStyle = '#ffffff';

        // Draw cloud as overlapping circles
        const cx = this.x + this.width / 2;
        const cy = this.y + this.height / 2;
        const rx = this.width / 2;
        const ry = this.height / 2;

        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();

        // Extra puffs
        ctx.beginPath();
        ctx.ellipse(cx - rx * 0.4, cy + 2, rx * 0.5, ry * 0.7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(cx + rx * 0.4, cy + 1, rx * 0.5, ry * 0.7, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }
}

export class Background {
    constructor() {
        this.groundOffset = 0;

        // Create clouds
        this.clouds = [];
        for (let i = 0; i < 4; i++) {
            this.clouds.push(new Cloud());
        }
    }

    /**
     * Update ground scroll and cloud positions.
     */
    update(gameSpeed) {
        this.groundOffset = (this.groundOffset + GROUND_SCROLL_SPEED * gameSpeed) % 24;
        for (const cloud of this.clouds) {
            cloud.update();
        }
    }

    /**
     * Draw the sky gradient.
     * @param {CanvasRenderingContext2D} ctx
     */
    drawSky(ctx) {
        const gradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT - GROUND_HEIGHT);
        gradient.addColorStop(0, '#4dc9f6');
        gradient.addColorStop(1, COLORS.sky);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT - GROUND_HEIGHT);
    }

    /**
     * Draw clouds.
     * @param {CanvasRenderingContext2D} ctx
     */
    drawClouds(ctx) {
        for (const cloud of this.clouds) {
            cloud.draw(ctx);
        }
    }

    /**
     * Draw the ground with parallax scrolling.
     * @param {CanvasRenderingContext2D} ctx
     */
    drawGround(ctx) {
        const groundY = CANVAS_HEIGHT - GROUND_HEIGHT;

        // Ground base
        ctx.fillStyle = COLORS.ground;
        ctx.fillRect(0, groundY, CANVAS_WIDTH, GROUND_HEIGHT);

        // Top edge / grass line
        ctx.fillStyle = COLORS.groundDark;
        ctx.fillRect(0, groundY, CANVAS_WIDTH, 4);

        // Scrolling pattern (dirt texture lines)
        ctx.strokeStyle = '#c4a84a';
        ctx.lineWidth = 1;
        for (let i = -24 + this.groundOffset; i < CANVAS_WIDTH; i += 24) {
            ctx.beginPath();
            ctx.moveTo(i, groundY + 12);
            ctx.lineTo(i + 12, groundY + 16);
            ctx.lineTo(i, groundY + 20);
            ctx.stroke();
        }

        // Lower ground stripe
        ctx.fillStyle = '#c9b458';
        ctx.fillRect(0, CANVAS_HEIGHT - 20, CANVAS_WIDTH, 20);

        // Dark bottom edge
        ctx.fillStyle = '#a08830';
        ctx.fillRect(0, CANVAS_HEIGHT - 2, CANVAS_WIDTH, 2);
    }

    /**
     * Draw the full background (sky + clouds + ground).
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} gameSpeed - Multiplier for scroll speed (1 = normal, 0 = paused)
     */
    draw(ctx, gameSpeed = 1) {
        this.drawSky(ctx);
        this.drawClouds(ctx);
        this.update(gameSpeed);
        this.drawGround(ctx);
    }
}
