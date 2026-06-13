'use strict';

const { httpState, httpsState } = require('./mockState');

jest.mock('http', () => {
  const httpRequest = jest.fn();
  httpRequest.mockImplementation((url, options, callback) => {
    const s = require('./mockState').httpState;
    const req = {
      on: jest.fn((event, handler) => {
        if (event === 'timeout') req._timeoutHandler = handler;
        if (event === 'error') req._errorHandler = handler;
        return req;
      }),
      end: jest.fn(() => {
        if (s.immediateInvoke) {
          if (s.error) {
            if (req._errorHandler) req._errorHandler(new Error(s.error));
          } else if (s.timeout) {
            if (req._timeoutHandler) req._timeoutHandler();
            req.destroy();
          } else {
            callback({ statusCode: s.status, on: jest.fn() });
          }
        }
      }),
      destroy: jest.fn(),
    };
    return req;
  });
  return { request: httpRequest };
});

jest.mock('https', () => {
  const httpsRequest = jest.fn();
  httpsRequest.mockImplementation((url, options, callback) => {
    const s = require('./mockState').httpsState;
    const req = {
      on: jest.fn((event, handler) => {
        if (event === 'timeout') req._timeoutHandler = handler;
        if (event === 'error') req._errorHandler = handler;
        return req;
      }),
      end: jest.fn(() => {
        if (s.immediateInvoke) {
          if (s.error) {
            if (req._errorHandler) req._errorHandler(new Error(s.error));
          } else if (s.timeout) {
            if (req._timeoutHandler) req._timeoutHandler();
            req.destroy();
          } else {
            callback({ statusCode: s.status, on: jest.fn() });
          }
        }
      }),
      destroy: jest.fn(),
    };
    return req;
  });
  return { request: httpsRequest };
});

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  statSync: jest.fn(),
}));

const { validateWebcamUrl, validateIndexHtml } = require('../validatePaths');
const fs = require('fs');

beforeEach(() => {
  jest.clearAllMocks();
  // Reset shared state
  httpState.immediateInvoke = true;
  httpState.status = 200;
  httpState.error = null;
  httpState.timeout = false;
  httpsState.immediateInvoke = true;
  httpsState.status = 200;
  httpsState.error = null;
  httpsState.timeout = false;
});

describe('validateWebcamUrl', () => {
  test('returns valid for a 200 response', async () => {
    const result = await validateWebcamUrl('http://example.com/cam.jpg');
    expect(result.valid).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
  });

  test('returns valid for a 302 redirect', async () => {
    httpState.status = 302;
    const result = await validateWebcamUrl('http://example.com/cam.jpg');
    expect(result.valid).toBe(true);
    expect(result.status).toBe(302);
  });

  test('returns invalid for a 404 response', async () => {
    httpState.status = 404;
    const result = await validateWebcamUrl('http://example.com/cam.jpg');
    expect(result.valid).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toBe('HTTP 404');
  });

  test('returns invalid for a 500 response', async () => {
    httpState.status = 500;
    const result = await validateWebcamUrl('http://example.com/cam.jpg');
    expect(result.valid).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBe('HTTP 500');
  });

  test('handles request error', async () => {
    httpState.error = 'ENOTFOUND';
    const result = await validateWebcamUrl('http://invalid-url/cam.jpg');
    expect(result.valid).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe('ENOTFOUND');
  });

  test('handles timeout', async () => {
    httpState.timeout = true;
    const result = await validateWebcamUrl('http://example.com/slow-cam.jpg');
    expect(result.valid).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe('Request timed out');
  });

  test('uses https for https URLs', async () => {
    const httpModule = require('http');
    const httpsModule = require('https');
    await validateWebcamUrl('https://example.com/cam.jpg');
    expect(httpsModule.request).toHaveBeenCalled();
  });

  test('rejects empty URL', async () => {
    const result = await validateWebcamUrl('');
    expect(result.valid).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe('No URL provided');
  });

  test('rejects null URL', async () => {
    const result = await validateWebcamUrl(null);
    expect(result.valid).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe('No URL provided');
  });
});

describe('validateIndexHtml', () => {
  test('returns valid when file exists', () => {
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ isFile: () => true });

    const result = validateIndexHtml('/var/www/index.html');
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toBe('/var/www/index.html');
    expect(result.error).toBeNull();
  });

  test('returns invalid when file does not exist', () => {
    fs.existsSync.mockReturnValue(false);

    const result = validateIndexHtml('/var/www/index.html');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('File does not exist');
  });

  test('returns invalid when path is a directory', () => {
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ isFile: () => false });

    const result = validateIndexHtml('/var/www/');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Path exists but is not a file');
  });

  test('handles fs error', () => {
    fs.existsSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const result = validateIndexHtml('/root/index.html');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Permission denied');
  });

  test('rejects empty path', () => {
    const result = validateIndexHtml('');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('No path provided');
  });

  test('resolves relative paths', () => {
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ isFile: () => true });

    const result = validateIndexHtml('./index.html');
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toMatch(/index\.html$/);
  });
});
