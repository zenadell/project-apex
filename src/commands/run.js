const { ensureProjectDir } = require('../orchestrator');

/**
 * Run command handler.
 * Accepts --project option and ensures the project directory exists before executing.
 */
async function handler(argv) {
  const projectName = argv.project || 'default';
  try {
    const projectPath = await ensureProjectDir(projectName);
    console.log(`Running in project: ${projectPath}`);
    // TODO: Add project-specific run logic here
  } catch (err) {
    console.error('Failed to run:', err.message);
    process.exit(1);
  }
}

module.exports = {
  command: 'run [script]',
  describe: 'Run a script in the project context',
  builder: (yargs) => {
    yargs
      .positional('script', {
        describe: 'Script to run (optional)',
        type: 'string',
        default: 'default',
      })
      .option('project', {
        describe: 'Project name',
        type: 'string',
        default: 'default',
      });
  },
  handler,
};
