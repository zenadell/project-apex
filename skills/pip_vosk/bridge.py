```python
#!/usr/bin/env python3
"""
Vosk CLI Bridge: Real-time offline speech recognition.

Accepts JSON input via stdin or command-line argument, processes audio,
and outputs JSON results to stdout.

Usage:
  python vosk_cli_bridge.py '{"model_path": "/path/to/model", "sample_rate": 16000}'
  echo '{"model_path": "/path/to/model"}' | python vosk_cli_bridge.py --stdin
"""

import sys
import json
import argparse
import traceback

try:
    from vosk import Model, KaldiRecognizer
    VOSK_AVAILABLE = True
except ImportError:
    VOSK_AVAILABLE = False

def load_config():
    """
    Load configuration from command-line argument or stdin.
    Returns a dictionary with at least 'model_path' and 'sample_rate'.
    """
    parser = argparse.ArgumentParser(
        description="Vosk CLI Bridge for offline speech recognition"
    )
    parser.add_argument(
        "json_input",
        nargs="?",
        help="JSON configuration as a string (alternative to stdin)"
    )
    parser.add_argument(
        "--stdin",
        action="store_true",
        help="Read JSON configuration from stdin"
    )
    args = parser.parse_args()

    config = None
    if args.json_input:
        try:
            config = json.loads(args.json_input)
        except json.JSONDecodeError as e:
            print_error("Invalid JSON in command-line argument", e)
            sys.exit(1)
    elif args.stdin or not args.json_input:
        # Read from stdin if no argument or --stdin is given
        raw = sys.stdin.read().strip()
        if raw:
            try:
                config = json.loads(raw)
            except json.JSONDecodeError as e:
                print_error("Invalid JSON from stdin", e)
                sys.exit(1)
    else:
        print_error("No configuration provided. Use --stdin or pass JSON as argument.")
        sys.exit(1)

    if config is None:
        print_error("Empty configuration.")
        sys.exit(1)

    # Default values
    config.setdefault("sample_rate", 16000)
    config.setdefault("input_type", "stdin")  # "stdin" or "mic"
    config.setdefault("channels", 1)
    config.setdefault("blocksize", 8000)

    if "model_path" not in config:
        print_error("'model_path' is required in configuration.")
        sys.exit(1)

    return config

def print_error(message, exception=None):
    """
    Print error message as JSON to stderr.
    """
    err = {"error": message}
    if exception:
        err["exception"] = str(exception)
    print(json.dumps(err), file=sys.stderr)

def print_result(result_dict):
    """
    Print a recognition result as JSON to stdout.
    """
    print(json.dumps(result_dict), flush=True)

def process_audio_stdin(recognizer, sample_rate, channels, blocksize):
    """
    Read raw PCM audio from stdin (16-bit, mono or stereo) and feed it to recognizer.
    """
    # If stereo, we average channels? Or assume mono? For simplicity, we read as is.
    # Vosk expects 16kHz mono 16-bit PCM. We'll read and convert if needed.
    # For now, assume stdin provides correct format.
    try:
        while True:
            data = sys.stdin.buffer.read(blocksize)
            if not data:
                break
            if recognizer.AcceptWaveform(data):
                result = json.loads(recognizer.Result())
                print_result({"final": result})
            else:
                partial = json.loads(recognizer.PartialResult())
                print_result({"partial": partial})
    except KeyboardInterrupt:
        # Flush final result
        final = json.loads(recognizer.FinalResult())
        print_result({"final": final})
        sys.exit(0)
    except Exception as e:
        print_error("Error processing audio from stdin", e)
        sys.exit(1)

def process_audio_mic(recognizer, sample_rate, channels, blocksize):
    """
    Capture audio from microphone using PyAudio (if available).
    """
    try:
        import pyaudio
    except ImportError:
        print_error("PyAudio is required for mic input. Install with 'pip install pyaudio'.")
        sys.exit(1)

    p = pyaudio.PyAudio()
    try:
        stream = p.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=sample_rate,
            input=True,
            frames_per_buffer=blocksize
        )
        print_result({"info": "Mic opened, listening..."})
        while True:
            data = stream.read(blocksize, exception_on_overflow=False)
            if recognizer.AcceptWaveform(data):
                result = json.loads(recognizer.Result())
                print_result({"final": result})
            else:
                partial = json.loads(recognizer.PartialResult())
                print_result({"partial": partial})
    except KeyboardInterrupt:
        print_result({"info": "Stopped by user"})
    except Exception as e:
        print_error("Error processing audio from microphone", e)
    finally:
        stream.stop_stream()
        stream.close()
        p.terminate()
        final = json.loads(recognizer.FinalResult())
        print_result({"final": final})

def main():
    if not VOSK_AVAILABLE:
        print_error("Vosk is not installed. Install with 'pip install vosk'.")
        sys.exit(1)

    config = load_config()
    model_path = config["model_path"]
    sample_rate = config["sample_rate"]
    input_type = config["input_type"]
    channels = config["channels"]
    blocksize = config["blocksize"]

    # Load model
    try:
        model = Model(model_path)
    except Exception as e:
        print_error("Failed to load model at '{}'".format(model_path), e)
        sys.exit(1)

    # Create recognizer
    try:
        recognizer = KaldiRecognizer(model, sample_rate)
    except Exception as e:
        print_error("Failed to create KaldiRecognizer", e)
        sys.exit(1)

    # Process input
    if input_type == "mic":
        process_audio_mic(recognizer, sample_rate, channels, blocksize)
    else:
        process_audio_stdin(recognizer, sample_rate, channels, blocksize)


if __name__ == "__main__":
    main()
```