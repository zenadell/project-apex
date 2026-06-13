```python
#!/usr/bin/env python3
import sys
import json
import argparse
import whisper

def transcribe(audio_path, model_name="base", language=None):
    """Transcribe audio file using OpenAI Whisper."""
    try:
        model = whisper.load_model(model_name)
        options = {}
        if language:
            options["language"] = language
        result = model.transcribe(audio_path, **options)
        return {
            "success": True,
            "text": result["text"],
            "language": result.get("language", "unknown"),
            "segments": result.get("segments", []),
            "duration": result.get("duration", 0.0)
        }
    except FileNotFoundError:
        return {"success": False, "error": f"Audio file not found: {audio_path}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    parser = argparse.ArgumentParser(description="Whisper CLI bridge for speech-to-text.")
    parser.add_argument("--audio", "-a", help="Path to audio file")
    parser.add_argument("--model", "-m", default="base", help="Whisper model size (tiny, base, small, medium, large)")
    parser.add_argument("--language", "-l", help="Language code (e.g., en) – auto-detect if not set")
    args = parser.parse_args()

    # Input: either from JSON on stdin or from command line arguments
    input_data = None
    if args.audio:
        input_data = {"audio": args.audio}
    elif not sys.stdin.isatty():
        try:
            input_data = json.loads(sys.stdin.read())
        except json.JSONDecodeError as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON: {str(e)}"}))
            return

    if not input_data or "audio" not in input_data:
        print(json.dumps({"success": False, "error": "No audio file provided. Use --audio or pipe JSON with 'audio' key."}))
        return

    audio_path = input_data["audio"]
    model_name = input_data.get("model", args.model or "base")
    language = input_data.get("language", args.language or None)

    result = transcribe(audio_path, model_name, language)
    print(json.dumps(result, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
```