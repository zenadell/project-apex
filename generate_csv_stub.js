const fs = require('fs');
const path = require('path');

const dir = path.join(process.env.HOME || process.env.USERPROFILE, 'apex_workspace');
const filePath = path.join(dir, 'default_placeholder.csv');

// Ensure directory exists
fs.mkdirSync(dir, { recursive: true });

// Write CSV header
fs.writeFileSync(filePath, 'id,value\n', 'utf8');

console.log(`Created ${filePath}`);
