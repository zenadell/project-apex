// plugins/webcam-capture.js
// APEX Native Webcam Capture — Uses ffmpeg + AVFoundation to grab a frame from the FaceTime camera.
// Returns the absolute path to the captured .jpg file.

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const CAPTURE_DIR = '/Users/mac/Downloads/apex 4/captures';

export default {
  async execute(instruction) {
    // Ensure capture directory exists
    if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true });

    const timestamp = Date.now();
    const outputPath = path.join(CAPTURE_DIR, `webcam_${timestamp}.jpg`);

    try {
      // Capture a single frame from device 0 (FaceTime HD Camera)
      // -y = overwrite, -f avfoundation = macOS camera input
      // -framerate 30 = required for avfoundation
      // -i "0" = video device index 0 (FaceTime HD Camera)
      // -frames:v 1 = capture exactly 1 frame
      // -q:v 2 = high quality JPEG
      // -ss 00:00:01.5 = wait 1.5 seconds to allow the camera sensor to auto-expose properly before snapping
      execSync(
        `${FFMPEG} -y -f avfoundation -framerate 30 -i "0" -ss 00:00:01.5 -frames:v 1 -q:v 2 "${outputPath}"`,
        { timeout: 15000, stdio: 'pipe' }
      );

      if (existsSync(outputPath)) {
        console.log(`[WebcamCapture] Photo saved: ${outputPath}`);
        return outputPath;
      } else {
        return 'Error: Photo file was not created.';
      }
    } catch (err) {
      console.error('[WebcamCapture] ffmpeg error:', err.stderr?.toString() || err.message);

      // Fallback: try screencapture (always works, captures screen instead of camera)
      try {
        const screenPath = path.join(CAPTURE_DIR, `screen_${timestamp}.jpg`);
        execSync(`screencapture -x -t jpg "${screenPath}"`, { timeout: 10000 });
        if (existsSync(screenPath)) {
          console.log(`[WebcamCapture] Fell back to screenshot: ${screenPath}`);
          return screenPath;
        }
      } catch (screenErr) {
        return `Error capturing: ${screenErr.message}`;
      }

      return `Error capturing webcam: ${err.message}`;
    }
  }
};
