/**
 * bird.js - Bird Class
 * Handles position, velocity, gravity, rotation, and procedural drawing.
 */
import {
    BIRD_X, BIRD_WIDTH, BIRD_HEIGHT,
    GRAVITY, JUMP_VELOCITY,
    BIRD_ROTATION_MAX, BIRD_ROTATION_FALL, BIRD_ROTATION_SPEED,
    COLORS, CANVAS_HEIGHT, GROUND_HEIGHT, STATE_PLAYING,
} from './constants.js';
import { clamp, lerp } from './utils.js';

export class Bird {
    constructor() {
        this.reset();
    }

    reset() {
        this.x = BIRD_X;
        this.y = CANVAS_HEIGHT / 2;
        this.width = BIRD_WIDTH;
        this.height = BIRD_HEIGHT;
        this.velocity = 0;
        this.rotation = 0;
        this.flapFrame = 0; // For simple wing animation
    }

    /**
     * Apply upward velocity (flap).
     */
    flap() {
        this.velocity = JUMP_VELOCITY;
    }

    /**
     * Update bird physics and rotation.
     */
    update() {
        this.velocity += GRAVITY;
        this.y += this.velocity;

        // Rotation: nose up on flap, nose down on fall
        if (this.velocity < 0) {
            // Rising — tilt nose up toward max
            this.rotation = lerp(this.rotation, BIRD_ROTATION_MAX, BIRD_ROTATION_SPEED);
        } else {
            // Falling — tilt nose down toward fall angle
            this.rotation = lerp(this.rotation, BIRD_ROTATION_FALL, BIRD_ROTATION_SPEED * 0.8);
        }

        // Simple wing flap animation
        this.flapFrame += 0.15;
    }

    /**
     * Check if bird hits ground or ceiling.
     * @returns {boolean}
     */
    hitBoundary() {
        return (
            this.y + this.height >= CANVAS_HEIGHT - GROUND_HEIGHT ||
            this.y <= 0
        );
    }

    /**
     * Draw the bird procedurally.
     * @param {CanvasRenderingContext2D} ctx
     */
    draw(ctx) {
        ctx.save();
        ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
        ctx.rotate(this.rotation);

        // Body (rounded ellipse)
        ctx.beginPath();
        ctx.ellipse(0, 0, this.width / 2, this.height / 2, 0, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.bird;
        ctx.fill();
        ctx.strokeStyle = '#c9a227';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Wing (animated)
        const wingAngle = Math.sin(this.flapFrame) * 0.3;
        ctx.save();
        ctx.rotate(wingAngle);
        ctx.beginPath();
        ctx.ellipse(-4, 2, 10, 6, -0.3, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.birdWing;
        ctx.fill();
        ctx.restore();

        // Eye (white circle with black pupil)
        ctx.beginPath();
        ctx.arc(6, -4, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Pupil
        ctx.beginPath();
        ctx.arc(7, -4, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.birdEye;
        ctx.fill();

        // Eye highlight
        ctx.beginPath();
        ctx.arc(8, -5.5, 1, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        // Beak
        ctx.beginPath();
        ctx.moveTo(10, -2);
        ctx.lineTo(19, 0);
        ctx.lineTo(10, 3);
        ctx.closePath();
        ctx.fillStyle = COLORS.birdBeak;
        ctx.fill();

        ctx.restore();
    }

    /**
     * Get the bounding box for collision detection.
     * @returns {{x: number, y: number, width: number, height: number}}
     */
    getBounds() {
        // Slightly shrink hitbox for fairer gameplay
        const shrink = 4;
        return {
            x: this.x + shrink,
            y: this.y + shrink,
            width: this.width - shrink * 2,
            height: this.height - shrink * 2,
        };
    }
}
