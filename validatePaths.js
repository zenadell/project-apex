'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

/**
 * Validates that a webcam image URL is accessible via HTTP HEAD request.
 * @param {string} url - The webcam image URL to validate.
 * @returns {Promise<{valid: boolean, status: number|null, error: string|null}>}
 */
function validateWebcamUrl(url) {
  return new Promise((resolve) => {
    if (!url || typeof url !== 'string') {
      return resolve({ valid: false, status: null, error: 'No URL provided' });
    }

    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.request(
      url,
      { method: 'HEAD', timeout: 10000 },
      (response) => {
        const status = response.statusCode;
        // Consider 2xx as valid, 3xx as valid (redirect OK for images)
        const valid = status >= 200 && status < 400;
        resolve({ valid, status, error: valid ? null : `HTTP ${status}` });
      }
    );

    request.on('error', (err) => {
      resolve({ valid: false, status: null, error: err.message });
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({ valid: false, status: null, error: 'Request timed out' });
    });

    request.end();
  });
}

/**
 * Validates that an index.html file exists at the given path.
 * @param {string} filePath - Absolute or relative path to index.html.
 * @returns {{valid: boolean, resolvedPath: string|null, error: string|null}}
 */
function validateIndexHtml(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, resolvedPath: null, error: 'No path provided' };
  }

  const resolvedPath = path.resolve(filePath);

  try {
    if (fs.existsSync(resolvedPath)) {
      const stats = fs.statSync(resolvedPath);
      if (stats.isFile()) {
        return { valid: true, resolvedPath, error: null };
      }
      return { valid: false, resolvedPath, error: 'Path exists but is not a file' };
    }
    return { valid: false, resolvedPath, error: 'File does not exist' };
  } catch (err) {
    return { valid: false, resolvedPath, error: err.message };
  }
}

module.exports = { validateWebcamUrl, validateIndexHtml };
