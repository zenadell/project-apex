
/**
 * Advanced Error Handling and Retry Mechanism
 * @class AdvancedRetryMechanism
 */
class AdvancedRetryMechanism {
  /**
   * Creates an instance of AdvancedRetryMechanism.
   * @param {number} [maxRetries=5] - Maximum number of retries.
   * @param {number} [factor=2] - Backoff factor for exponential backoff.
   * @param {number} [minTimeout=1000] - Minimum timeout in milliseconds.
   * @param {number} [maxTimeout=60000] - Maximum timeout in milliseconds.
   * @param {boolean} [randomize=true] - Randomize the backoff time.
   */
  constructor(maxRetries = 5, factor = 2, minTimeout = 1000, maxTimeout = 60000, randomize = true) {
    this.maxRetries = maxRetries;
    this.factor = factor;
    this.minTimeout = minTimeout;
    this.maxTimeout = maxTimeout;
    this.randomize = randomize;
  }

  /**
   * Makes a request with retry mechanism.
   * @param {string} url - The URL to make the request to.
   * @param {Function} [onSuccess] - Callback for successful requests.
   * @param {Function} [onError] - Callback for errors.
   */
  async makeRequest(url, onSuccess = () => {}, onError = () => {}) {
    const operation = retry.operation({
      retries: this.maxRetries,
      factor: this.factor,
      minTimeout: this.minTimeout,
      maxTimeout: this.maxTimeout,
      randomize: this.randomize
    });

    return new Promise((resolve, reject) => {
      operation.attempt(async (currentAttempt) => {
        try {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          const data = await response.json();
          onSuccess(data);
          resolve(data);
        } catch (error) {
          if (operation.retry(error)) {
            console.log(`Attempt ${currentAttempt} failed, retrying...`);
          } else {
            onError(error);
            reject(error);
          }
        }
      });
    });
  }
}

module.exports = AdvancedRetryMechanism;
