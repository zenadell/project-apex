const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
];

const TIMEOUT = 10000;

/**
 * Extract text content from <body>, stripping <script> and <style> tags.
 * @param {cheerio.CheerioAPI} $
 * @returns {string}
 */
function extractBodyText($) {
  // Remove script and style elements
  $('script').remove();
  $('style').remove();
  // Get body text, trim whitespace
  const bodyText = $('body').text().trim();
  return bodyText;
}

/**
 * Scrape a URL and return structured result.
 * @param {string} url
 * @param {Object} [options] - Optional settings.
 * @param {boolean} [options.returnHtml=false] - If true, include raw HTML in result.
 * @returns {Promise<{success: boolean, data?: {title: string, body: string, html?: string}, error?: string}>}
 */
async function scrape(url, options = {}) {
  let lastError = null;

  for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
    const userAgent = USER_AGENTS[attempt];
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': userAgent,
        },
        timeout: TIMEOUT,
        // Do not throw on non-2xx status codes; we handle them manually
        validateStatus: (status) => true,
      });

      const status = response.status;

      // If status is 4xx or 5xx, retry with next User-Agent
      if (status >= 400 && status < 600) {
        lastError = `HTTP ${status}: ${response.statusText}`;
        // If this is the last attempt, break out to return error
        if (attempt === USER_AGENTS.length - 1) {
          break;
        }
        // Otherwise continue to next attempt
        continue;
      }

      // Successful response (2xx or 3xx)
      const html = response.data;
      const $ = cheerio.load(html);

      const title = $('title').first().text().trim();
      const body = extractBodyText($);

      const resultData = {
        title,
        body,
      };
      if (options.returnHtml) {
        resultData.html = html;
      }
      return {
        success: true,
        data: resultData,
      };
    } catch (err) {
      // Network error, timeout, etc.
      lastError = err.message || 'Unknown error';
      // If this is the last attempt, break out to return error
      if (attempt === USER_AGENTS.length - 1) {
        break;
      }
      // Otherwise continue to next attempt
      continue;
    }
  }

  // All attempts exhausted
  return {
    success: false,
    error: lastError || 'Failed to fetch URL',
  };
}

module.exports = { scrape };
