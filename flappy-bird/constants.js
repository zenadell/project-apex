/**
 * constants.js - Game Constants
 * All configurable game parameters in one place.
 */

export const CANVAS_WIDTH = 400;
export const CANVAS_HEIGHT = 600;

// Bird physics
export const BIRD_X = 80;
export const BIRD_WIDTH = 34;
export const BIRD_HEIGHT = 24;
export const GRAVITY = 0.5;
export const JUMP_VELOCITY = -7.5;
export const BIRD_ROTATION_MAX = Math.PI / 4;  // 45 degrees max tilt up
export const BIRD_ROTATION_FALL = -Math.PI / 2; // -90 degrees when falling
export const BIRD_ROTATION_SPEED = 0.1;

// Pipe settings
export const PIPE_WIDTH = 52;
export const PIPE_GAP = 140;
export const PIPE_SPEED = 2.5;
export const PIPE_SPAWN_INTERVAL = 1500; // ms between pipe spawns
export const PIPE_MIN_HEIGHT = 60;

// Ground settings
export const GROUND_HEIGHT = 80;
export const GROUND_SCROLL_SPEED = 2;

// Colors (procedurally drawn, no sprites needed)
export const COLORS = {
    sky: '#70c5ce',
    ground: '#ded895',
    groundDark: '#d2b44c',
    bird: '#f5c842',
    birdWing: '#e6a817',
    birdEye: '#000000',
    birdBeak: '#e85d04',
    pipe: '#73bf2e',
    pipeDark: '#558b2f',
    pipeBorder: '#33691e',
    pipeHighlight: '#8bc34a',
};

// Game state identifiers
export const STATE_READY = 'ready';
export const STATE_PLAYING = 'playing';
export const STATE_GAMEOVER = 'gameover';

// Scoring
export const SCORE_PER_PIPE = 1;
export const BEST_SCORE_KEY = 'flappyBirdBest';
