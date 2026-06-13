```javascript
#!/usr/bin/env node

/**
 * restart-and-reload.js
 *
 * Detects if a Python HTTP server is running on port 8000, restarts it if found,
 * opens the dashboard/index.html, and confirms the selfie.jpg image loads correctly
 * via HTTP HEAD or file existence check.
 *
 * Architecture:
 *  - Uses lsof to find process listening on port 8000 (macOS/Linux)
 *  - Kills and restarts the server (Python 3 http.server)
 *  - Opens the dashboard in the default browser
 *  - Verifies selfie.jpg: if server is running, HTTP HEAD to /selfie.jpg (expect 200)
 *    otherwise, checks file existence in dashboard/selfie.jpg
 *
 * Design Patterns: Script, Process Manager, Health Check
 * Platform: macOS/Linux (with fallback notes for Windows)
 *
 * Output:
 *  Console logs about detected server, restart, browser open, and image verification.
 *  Exits with code 0 on success, 1 on error.
 */

const { exec, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8000;
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');
const INDEX_HTML = path.join(DASHBOARD_DIR, 'index.html');
const SELFIE_JPG = path.join(DASHBOARD_DIR, 'selfie.jpg');

// Utility: run a command and return stdout
function run(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', ...options });
  } catch (e) {
    return null;
  }
}

// Check if something is listening on port 8000 (returns PID or null)
function findServerPid() {
  const output = run(`lsof -ti tcp:${PORT} -sTCP:LISTEN`);
  if (output) {
    const lines = output.trim().split('\n');
    // lsof may return multiple lines; take the first non-empty PID
    for (const line of lines) {
      const pid = line.trim();
      if (pid && /^\d+$/.test(pid)) return pid;
    }
  }
  return null;
}

// Kill a process by PID
function killProcess(pid) {
  try {
    process.kill(parseInt(pid, 10), 'SIGTERM');
    console.log(`  Killed existing server process (PID ${pid})`);
    // Wait a moment for cleanup
    return new Promise((resolve) => setTimeout(resolve, 500));
  } catch (err) {
    console.error(`  Failed to kill process ${pid}: ${err.message}`);
    return Promise.resolve();
  }
}

// Start Python HTTP server in dashboard directory
function startServer() {
  return new Promise((resolve, reject) => {
    const server = require('child_process').spawn('python3', ['-m', 'http.server', PORT.toString()], {
      cwd: DASHBOARD_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    server.stdout.on('data', (data) => {
      console.log(`  Server output: ${data}`);
    });

    server.stderr.on('data', (data) => {
      console.error(`  Server error: ${data}`);
    });

    server.on('error', (err) => {
      console.error(`  Failed to start server: ${err.message}`);
      reject(err);
    });

    server.on('spawn', () => {
      console.log(`  Started Python HTTP server on port ${PORT}`);
      // Give it a moment to bind
      setTimeout(() => resolve(server), 600);
    });
  });
}

// Open the dashboard in default browser
function openDashboard() {
  const url = `http://localhost:${PORT}/index.html`;
  const platform = process.platform;
  let cmd;
  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'linux') {
    cmd = `xdg-open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    console.log(`  Please open the dashboard manually: ${url}`);
    return;
  }
  try {
    execSync(cmd, { stdio: 'ignore' });
    console.log(`  Opened browser to ${url}`);
  } catch (e) {
    console.error(`  Failed to open browser: ${e.message}`);
    console.log(`  Please open the dashboard manually: ${url}`);
  }
}

// Verify selfie.jpg loads via HTTP or file existence
function verifyImage(useServer) {
  return new Promise((resolve, reject) => {
    if (useServer) {
      // HTTP HEAD request
      const req = http.request({
        hostname: 'localhost',
        port: PORT,
        path: '/selfie.jpg',
        method: 'HEAD'
      }, (res) => {
        if (res.statusCode === 200) {
          console.log('✓ selfie.jpg loads correctly via HTTP (200 OK)');
          resolve(true);
        } else {
          console.error(`✗ selfie.jpg returned HTTP ${res.statusCode}`);
          resolve(false);
        }
      });
      req.on('error', (err) => {
        console.error(`✗ HTTP request failed: ${err.message}`);
        resolve(false);
      });
      req.end();
    } else {
      // File existence check
      if (fs.existsSync(SELFIE_JPG)) {
        console.log('✓ selfie.jpg found on filesystem');
        resolve(true);
      } else {
        console.error(`✗ selfie.jpg not found at ${SELFIE_JPG}`);
        resolve(false);
      }
    }
  });
}

// Main execution
async function main() {
  console.log('=== APEX Dashboard Reload & Image Check ===');
  console.log('');

  // Check if dashboard/index.html exists
  if (!fs.existsSync(INDEX_HTML)) {
    console.error(`✗ Dashboard index.html not found at ${INDEX_HTML}`);
    console.log('  Ensure dashboard/index.html exists before running this script.');
    process.exit(1);
  }

  // Detect any existing server on port 8000
  let pid = findServerPid();
  let useServer = false;

  if (pid) {
    console.log(`Found server process PID ${pid} on port ${PORT}`);
    await killProcess(pid);
    // After kill, wait a moment and then start new server
    console.log('  Restarting server...');
    try {
      await startServer();
      useServer = true;
    } catch (e) {
      console.error('  Could not restart server. Falling back to file:// open.');
      useServer = false;
    }
  } else {
    console.log('No server detected on port 8000. Will use file:// opening.');
    // We still might want to start one? The objective says "if using dev server, restart it.
    // Otherwise, inform that file:// usage requires no reload." So if no server, we go file://
    useServer = false;
  }

  // Open the dashboard
  if (useServer) {
    openDashboard();
  } else {
    // Open via file protocol
    const fileUrl = `file://${INDEX_HTML}`;
    const platform = process.platform;
    if (platform === 'darwin') {
      exec(`open "${fileUrl}"`);
    } else if (platform === 'linux') {
      exec(`xdg-open "${fileUrl}"`);
    } else if (platform === 'win32') {
      exec(`start "" "${fileUrl}"`);
    } else {
      console.log(`  Please open the dashboard manually: ${fileUrl}`);
    }
    console.log(`  Opened browser to ${fileUrl}`);
  }

  // Verify image loads
  const imageOk = await verifyImage(useServer);

  if (imageOk) {
    console.log('\n✓ All checks passed. Dashboard opened and selfie.jpg confirmed.');
    process.exit(0);
  } else {
    console.log('\n⚠ Image verification failed. Check dashboard/selfie.jpg exists and server routes correctly.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
```