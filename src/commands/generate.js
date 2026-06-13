const { ensureProjectDir } = require('../orchestrator');

/**
 * Generate command handler.
 * Accepts --project option and ensures the project directory exists before executing.
 */
async function handler(argv) {
  const projectName = argv.project || 'default';
  try {
    const projectPath = await ensureProjectDir(projectName);
    console.log(`Generating in project: ${projectPath}`);
    // TODO: Add project-specific generation logic here
  } catch (err) {
    console.error('Failed to generate:', err.message);
    process.exit(1);
  }
}

module.exports = {
  command: 'generate <type>',
  describe: 'Generate a new resource (e.g., component, module)',
  builder: (yargs) => {
    yargs
      .positional('type', {
        describe: 'Type of resource to generate',
        type: 'string',
      })
      .option('project', {
        describe: 'Project name',
        type: 'string',
        default: 'default',
      });
  },
  handler,
};
