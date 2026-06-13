```python
#!/usr/bin/env python3
"""
CLI bridge for PyAudio: live microphone capture for earnings call streaming.

Accepts JSON input via stdin or --input argument. Captures audio from microphone
using PyAudio and outputs JSON results (base64-encoded audio or file path).
Handles errors gracefully.
"""

import argparse
import json
import sys
import base64
import wave
import io

try:
    import pyaudio
except ImportError:
    print(json.dumps({"error": "pyaudio not installed. Install with: pip install pyaudio"}))
    sys.exit(1)

def record_audio(device_index=None, sample_rate=44100, channels=1, chunk=1024, duration=5, output_file=None):
    """
    Capture audio from microphone using PyAudio.
    
    Parameters:
        device_index (int or None): Index of audio input device (None = default)
        sample_rate (int): Sample rate in Hz
        channels (int): Number of channels (1 mono, 2 stereo)
        chunk (int): Frames per buffer
        duration (float): Recording duration in seconds
        output_file (str or None): If provided, save WAV to this file; else return base64
    
    Returns:
        dict: {"status": "ok", "data": base64_string or file_path} or {"status": "error", "message": ...}
    """
    p = pyaudio.PyAudio()
    try:
        # Validate device index if given
        if device_index is not None:
            if device_index < 0 or device_index >= p.get_device_count():
                return {"status": "error", "message": f"Invalid device index {device_index}. Available: 0..{p.get_device_count()-1}"}
            device_info = p.get_device_info_by_index(device_index)
            if device_info.get('maxInputChannels', 0) == 0:
                return {"status": "error", "message": f"Device {device_index} ({device_info.get('name')}) has no input channels"}
        
        # Open stream
        stream = p.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=sample_rate,
            input=True,
            input_device_index=device_index,
            frames_per_buffer=chunk
        )

        frames = []
        for _ in range(0, int(sample_rate / chunk * duration)):
            data = stream.read(chunk, exception_on_overflow=False)
            frames.append(data)

        # Stop and close stream
        stream.stop_stream()
        stream.close()

        # Build WAV in memory
        wav_buffer = io.BytesIO()
        wf = wave.open(wav_buffer, 'wb')
        wf.setnchannels(channels)
        wf.setsampwidth(p.get_sample_size(pyaudio.paInt16))
        wf.setframerate(sample_rate)
        wf.writeframes(b''.join(frames))
        wf.close()

        if output_file:
            # Save to file
            with open(output_file, 'wb') as f:
                f.write(wav_buffer.getvalue())
            return {"status": "ok", "file": output_file}
        else:
            # Return base64
            b64_data = base64.b64encode(wav_buffer.getvalue()).decode('utf-8')
            return {"status": "ok", "data": b64_data}

    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        p.terminate()

def main():
    parser = argparse.ArgumentParser(description="PyAudio CLI bridge for microphone capture")
    parser.add_argument('--input', type=str, help='JSON input as a string (if not provided, read from stdin)')
    parser.add_argument('--output-file', type=str, help='Save captured audio to this WAV file instead of returning base64')
    args = parser.parse_args()

    # Get JSON input
    if args.input:
        try:
            input_data = json.loads(args.input)
        except json.JSONDecodeError as e:
            print(json.dumps({"status": "error", "message": f"Invalid JSON input string: {e}"}))
            sys.exit(1)
    else:
        # Read from stdin (until EOF)
        try:
            raw = sys.stdin.read()
            if not raw.strip():
                print(json.dumps({"status": "error", "message": "No input provided via stdin"}))
                sys.exit(1)
            input_data = json.loads(raw)
        except json.JSONDecodeError as e:
            print(json.dumps({"status": "error", "message": f"Invalid JSON from stdin: {e}"}))
            sys.exit(1)

    # Merge output_file from command line (overrides JSON if present)
    output_file = args.output_file or input_data.get('output_file')

    # Extract parameters with defaults
    device_index = input_data.get('device_index', None)
    sample_rate = input_data.get('sample_rate', 44100)
    channels = input_data.get('channels', 1)
    chunk = input_data.get('chunk', 1024)
    duration = input_data.get('duration', 5)

    # Record and output result
    result = record_audio(
        device_index=device_index,
        sample_rate=sample_rate,
        channels=channels,
        chunk=chunk,
        duration=duration,
        output_file=output_file
    )
    print(json.dumps(result))

if __name__ == '__main__':
    main()
```