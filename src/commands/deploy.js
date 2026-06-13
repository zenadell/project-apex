const { ensureProjectDir } = require('../orchestrator');

/**
 * Deploy command handler.
 * Accepts --project option and ensures the project directory exists before executing.
 */
async function handler(argv) {
  const projectName = argv.project || 'default';
  try {
    const projectPath = await ensureProjectDir(projectName);
    console.log(`Deploying project: ${projectPath}`);
    // TODO: Add project-specific deploy logic here
  } catch (err) {
    console.error('Failed to deploy:', err.message);
    process.exit(1);
  }
}

module.exports = {
  command: 'deploy [target]',
  describe: 'Deploy the project to a target environment',
  builder: (yargs) => {
    yargs
      .positional('target', {
        describe: 'Deployment target (e.g., staging, production)',
        type: 'string',
        default: 'staging',
      })
      .option('project', {
        describe: 'Project name',
        type: 'string',
        default: 'default',
      });
  },
  handler,
};
