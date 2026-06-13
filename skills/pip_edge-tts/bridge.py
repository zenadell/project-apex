```python
#!/usr/bin/env python3
"""
CLI bridge for edge-tts.

Accepts JSON input via stdin (no arguments) or as a command-line argument.
Processes the request and returns JSON output with status and result.

Input fields:
- text (required): text to synthesize
- voice (optional): voice name (default: 'en-US-AriaNeural')
- rate (optional): speaking rate, e.g. '+0%', '-20%'
- volume (optional): volume, e.g. '+0%', '-20%'
- pitch (optional): pitch, e.g. '+0Hz', '-10%'
- output (optional): output file path; if omitted, raw audio is streamed to stdout

Output JSON:
- On success: {"status": "ok", "file": "<path>"} or {"status": "ok", "streamed": true}
- On error: {"status": "error", "message": "..."}
"""

import sys
import json
import asyncio
from edge_tts import Communicate

async def synthesize(data):
    text = data.get("text")
    if not text:
        raise ValueError("Missing 'text' field")
    voice = data.get("voice", "en-US-AriaNeural")
    rate = data.get("rate")
    volume = data.get("volume")
    pitch = data.get("pitch")
    output = data.get("output")

    # Build Communicate object with optional parameters
    kwargs = {"text": text, "voice": voice}
    if rate:
        kwargs["rate"] = rate
    if volume:
        kwargs["volume"] = volume
    if pitch:
        kwargs["pitch"] = pitch
    communicate = Communicate(**kwargs)

    if output:
        # Save to file
        await communicate.save(output)
        return {"status": "ok", "file": output}
    else:
        # Stream raw audio to stdout (binary)
        # We'll gather the audio chunks and write to stdout
        # Since stdout is text-based, we must ensure binary mode.
        # We'll use sys.stdout.buffer.write() for raw audio.
        # Also note that edge_tts streams in chunks.
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                sys.stdout.buffer.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                # Optionally output word boundary events as JSON lines? Not now.
                pass
        sys.stdout.buffer.flush()
        return {"status": "ok", "streamed": True}

def main():
    # Read input JSON
    if len(sys.argv) > 1:
        # From command-line argument
        input_data = sys.argv[1]
    else:
        # From stdin
        input_data = sys.stdin.read()

    try:
        data = json.loads(input_data)
    except json.JSONDecodeError as e:
        print(json.dumps({"status": "error", "message": f"Invalid JSON: {e}"}))
        sys.exit(1)

    try:
        result = asyncio.run(synthesize(data))
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
```