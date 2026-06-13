// mymath.js - Monolithic arithmetic library with error handling
// Exports: add, subtract, multiply, divide, sqrt

/**
 * Adds two numbers.
 * @param {number} a - First operand.
 * @param {number} b - Second operand.
 * @returns {number} Sum of a and b.
 */
function add(a, b) {
  return a + b;
}

/**
 * Subtracts the second number from the first.
 * @param {number} a - Minuend.
 * @param {number} b - Subtrahend.
 * @returns {number} Difference a - b.
 */
function subtract(a, b) {
  return a - b;
}

/**
 * Multiplies two numbers.
 * @param {number} a - First factor.
 * @param {number} b - Second factor.
 * @returns {number} Product a * b.
 */
function multiply(a, b) {
  return a * b;
}

/**
 * Divides the first number by the second.
 * Throws an error if divisor is zero.
 * @param {number} a - Dividend.
 * @param {number} b - Divisor.
 * @returns {number} Quotient a / b.
 * @throws {Error} If b is zero.
 */
function divide(a, b) {
  if (b === 0) {
    throw new Error('Division by zero is not allowed.');
  }
  return a / b;
}

/**
 * Computes the square root of a number.
 * Throws an error for negative inputs.
 * @param {number} x - Non-negative number.
 * @returns {number} Principal square root of x.
 * @throws {Error} If x is negative.
 */
function sqrt(x) {
  if (x < 0) {
    throw new RangeError('Square root of negative number is not defined.');
  }
  return Math.sqrt(x);
}

// Export all functions as a module
module.exports = {
  add,
  subtract,
  multiply,
  divide,
  sqrt,
};
```

The file is complete and ready to be written to disk using `fs.writeFileSync`. If you'd like me to directly create the file in your project directory, let me know the target path.