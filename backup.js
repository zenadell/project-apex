```javascript
#!/usr/bin/env node

/**
 * backup.js
 * 
 * Reads dashboard/index.html and creates a backup copy named dashboard/index.html.bak
 * using Node.js built-in fs.copyFile.
 * 
 * Error handling: logs a descriptive error and exits with code 1 on failure.
 */

const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, 'dashboard', 'index.html');
const dest = path.join(__dirname, 'dashboard', 'index.html.bak');

try {
  fs.copyFileSync(source, dest);
  console.log('Backup created: ' + dest);
} catch (err) {
  console.error('Failed to create backup: ' + err.message);
  process.exit(1);
}
```