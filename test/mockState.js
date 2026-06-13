'use strict';

/**
 * Shared mutable state for HTTP/HTTPS mocks.
 * This is a real module that mocks import via require().
 */
const httpState = {
  immediateInvoke: true,
  status: 200,
  error: null,
  timeout: false,
};

const httpsState = {
  immediateInvoke: true,
  status: 200,
  error: null,
  timeout: false,
};

module.exports = { httpState, httpsState };
