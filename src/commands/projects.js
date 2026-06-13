const { ensureProjectDir } = require('../orchestrator');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const PROJECTS_DIR = path.resolve(process.cwd(), 'projects');

/**
 * Projects command group: init, list, open.
 */
function builder(yargs) {
  return yargs
    .command('init <project-name>', 'Initialize a new project directory', (yargs) => {
      yargs.positional('project-name', {
        describe: 'Name of the project to create',
        type: 'string',
      });
    }, async (argv) => {
      try {
        const projectPath = await ensureProjectDir(argv.projectName);
        console.log(`Project initialized at: ${projectPath}`);
      } catch (err) {
        console.error('Failed to initialize project:', err.message);
        process.exit(1);
      }
    })
    .command('list', 'List existing projects', {}, async () => {
      try {
        await fs.ensureDir(PROJECTS_DIR);
        const entries = await fs.readdir(PROJECTS_DIR);
        const projects = entries.filter((entry) =>
          fs.statSync(path.join(PROJECTS_DIR, entry)).isDirectory()
        );
        if (projects.length === 0) {
          console.log('No projects found.');
        } else {
          console.log('Projects:');
          projects.forEach((p) => console.log(`  - ${p}`));
        }
      } catch (err) {
        console.error('Failed to list projects:', err.message);
        process.exit(1);
      }
    })
    .command('open <project-name>', 'Open a project in the default editor/file manager', (yargs) => {
      yargs.positional('project-name', {
        describe: 'Name of the project to open',
        type: 'string',
      });
    }, async (argv) => {
      try {
        const projectPath = await ensureProjectDir(argv.projectName);
        // Attempt to open in default editor (macOS: open, Linux: xdg-open, Windows: start)
        const platform = process.platform;
        let cmd;
        if (platform === 'darwin') {
          cmd = `open "${projectPath}"`;
        } else if (platform === 'win32') {
          cmd = `start "" "${projectPath}"`;
        } else {
          cmd = `xdg-open "${projectPath}"`;
        }
        execSync(cmd, { stdio: 'inherit' });
        console.log(`Opened project: ${projectPath}`);
      } catch (err) {
        console.error('Failed to open project:', err.message);
        process.exit(1);
      }
    });
}

module.exports = {
  command: 'projects',
  describe: 'Manage projects (init, list, open)',
  builder,
  handler: (argv) => {
    // yargs will handle subcommands automatically
    // If no subcommand is given, show help
    argv.showHelp();
  },
};
