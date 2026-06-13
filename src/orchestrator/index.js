const fs = require('fs-extra');
const path = require('path');
const lockfile = require('proper-lockfile');

const PROJECTS_DIR = path.resolve(process.cwd(), 'projects');

/**
 * Ensures that a project directory exists, creating it atomically if needed.
 * Uses proper-lockfile to prevent race conditions when multiple processes
 * attempt to create the same directory simultaneously.
 *
 * @param {string} projectName - Name of the project directory to ensure.
 * @returns {Promise<string>} - Resolves with the absolute path to the project directory.
 */
async function ensureProjectDir(projectName) {
  const projectPath = path.join(PROJECTS_DIR, projectName);

  // Ensure the parent projects directory exists first
  await fs.ensureDir(PROJECTS_DIR);

  // Acquire a lock on the project directory to prevent concurrent creation
  const release = await lockfile.lock(projectPath, {
    retries: {
      retries: 5,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 2000,
    },
  });

  try {
    // Check if the directory already exists (created by another process)
    const exists = await fs.pathExists(projectPath);
    if (!exists) {
      // Create the directory atomically
      await fs.ensureDir(projectPath);
    }
    return projectPath;
  } finally {
    // Release the lock
    await release();
  }
}

module.exports = { ensureProjectDir };
