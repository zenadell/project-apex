```python
#!/usr/bin/env python3
"""
CLI bridge for webrtcvad Voice Activity Detection.

Accepts JSON input via stdin or as a command-line argument.
Expected input format:
  {"audio": "<base64 encoded 16-bit PCM mono>", "sample_rate": 16000, "frame_duration_ms": 30, "mode": 0}
If not provided, defaults: sample_rate=16000, frame_duration_ms=30, mode=0.

Outputs JSON with detected speech segments (start/end in seconds) or an error field.
"""

import json
import sys
import base64
import webrtcvad
from typing import Dict, List, Any

def process_vad(audio_bytes: bytes, sample_rate: int, frame_duration_ms: int, mode: int) -> List[Dict[str, float]]:
    """
    Run VAD on raw PCM audio and return list of speech segments.
    Each segment: {"start": seconds, "end": seconds}.
    """
    vad = webrtcvad.Vad(mode)
    frame_size = int(sample_rate * (frame_duration_ms / 1000.0)) * 2  # 2 bytes per sample
    # We'll split audio into frames, track active/inactive blocks
    active = False
    start_time = 0.0
    segments = []
    offset = 0
    while offset + frame_size <= len(audio_bytes):
        frame = audio_bytes[offset:offset + frame_size]
        is_speech = vad.is_speech(frame, sample_rate)
        current_time = offset / (sample_rate * 2)  # seconds

        if is_speech and not active:
            active = True
            start_time = current_time
        elif not is_speech and active:
            active = False
            segments.append({"start": round(start_time, 3), "end": round(current_time, 3)})
        offset += frame_size

    # If still active at end, close segment
    if active:
        segments.append({"start": round(start_time, 3), "end": round(len(audio_bytes) / (sample_rate * 2), 3)})

    return segments

def parse_input() -> Dict[str, Any]:
    """Get and parse JSON from command line arg or stdin."""
    raw = None
    if len(sys.argv) > 1:
        raw = sys.argv[1]
    else:
        if not sys.stdin.isatty():
            raw = sys.stdin.read().strip()
    if not raw:
        raise ValueError("No input provided. Supply JSON via first argument or stdin.")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON: {e}")

def main() -> None:
    try:
        data = parse_input()
        required_keys = ["audio"]
        missing = [k for k in required_keys if k not in data]
        if missing:
            raise ValueError(f"Missing required keys: {missing}")

        # Decode base64 audio
        try:
            audio_bytes = base64.b64decode(data["audio"])
        except Exception as e:
            raise ValueError(f"Failed to decode audio base64: {e}")

        sample_rate = data.get("sample_rate", 16000)
        frame_duration_ms = data.get("frame_duration_ms", 30)
        mode = data.get("mode", 0)

        # Validate parameters
        if sample_rate not in (8000, 16000, 32000, 48000):
            raise ValueError("sample_rate must be 8000, 16000, 32000, or 48000")
        if frame_duration_ms not in (10, 20, 30):
            raise ValueError("frame_duration_ms must be 10, 20, or 30")
        if mode not in (0, 1, 2, 3):
            raise ValueError("mode must be 0–3")

        segments = process_vad(audio_bytes, sample_rate, frame_duration_ms, mode)
        output = {"segments": segments, "error": None}

    except Exception as e:
        output = {"segments": [], "error": str(e)}

    print(json.dumps(output))

if __name__ == "__main__":
    main()
```