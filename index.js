'use strict';

const { validateWebcamUrl, validateIndexHtml } = require('./validatePaths');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { webcamUrl: null, indexPath: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--webcam-url' && i + 1 < args.length) {
      options.webcamUrl = args[++i];
    } else if (args[i] === '--index-path' && i + 1 < args.length) {
      options.indexPath = args[++i];
    }
  }

  return options;
}

async function main() {
  const { webcamUrl, indexPath } = parseArgs();

  if (!webcamUrl || !indexPath) {
    console.error('Usage: node index.js --webcam-url <url> --index-path <path>');
    process.exit(1);
  }

  console.log(`Validating webcam URL: ${webcamUrl}`);
  const webcamResult = await validateWebcamUrl(webcamUrl);
  console.log(`  -> Valid: ${webcamResult.valid}, Status: ${webcamResult.status}, Error: ${webcamResult.error || 'none'}`);

  console.log(`\nValidating index.html path: ${indexPath}`);
  const indexResult = validateIndexHtml(indexPath);
  console.log(`  -> Valid: ${indexResult.valid}, Resolved: ${indexResult.resolvedPath}, Error: ${indexResult.error || 'none'}`);

  const allValid = webcamResult.valid && indexResult.valid;
  console.log(`\n${allValid ? 'PASS: All paths valid' : 'FAIL: One or more paths invalid'}`);

  process.exit(allValid ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Unexpected error:', err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
