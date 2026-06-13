```python
#!/usr/bin/env python3
"""
CLI bridge for faster-whisper.
Accepts JSON input via stdin or --input-json argument.
Outputs transcription results as JSON.
"""

import argparse
import json
import sys
import os
from typing import Optional, Dict, Any

try:
    from faster_whisper import WhisperModel
    import faster_whisper
except ImportError:
    print(json.dumps({"error": "faster-whisper not installed. Run: pip install faster-whisper"}))
    sys.exit(1)

def parse_args() -> Dict[str, Any]:
    """Parse command line arguments and extract input JSON."""
    parser = argparse.ArgumentParser(description="CLI bridge for faster-whisper")
    parser.add_argument("--input-json", type=str, help="JSON string with input parameters")
    args = parser.parse_args()

    if args.input_json:
        try:
            return json.loads(args.input_json)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON in --input-json: {str(e)}"}))
            sys.exit(1)
    else:
        # Read from stdin if not a terminal (piped input)
        if not sys.stdin.isatty():
            try:
                raw = sys.stdin.read()
                if raw.strip():
                    return json.loads(raw)
            except json.JSONDecodeError as e:
                print(json.dumps({"error": f"Invalid JSON from stdin: {str(e)}"}))
                sys.exit(1)
        else:
            print(json.dumps({"error": "No input provided. Provide JSON via stdin or --input-json argument."}))
            sys.exit(1)

def transcribe_audio(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """Run faster-whisper transcription on the given audio file."""
    audio_file = input_data.get("audio_file")
    if not audio_file:
        return {"error": "Missing required field: 'audio_file'"}

    if not os.path.isfile(audio_file):
        return {"error": f"Audio file not found: {audio_file}"}

    model_size = input_data.get("model_size", "base")
    device = input_data.get("device", "auto")
    compute_type = input_data.get("compute_type", "float16")
    cpu_threads = input_data.get("cpu_threads", 0)

    # Transcription options
    language = input_data.get("language", None)
    task = input_data.get("task", "transcribe")
    beam_size = input_data.get("beam_size", 5)
    best_of = input_data.get("best_of", 5)
    temperature = input_data.get("temperature", [0.0, 0.2, 0.4, 0.6, 0.8, 1.0])
    vad_filter = input_data.get("vad_filter", False)
    vad_parameters = input_data.get("vad_parameters", None)

    try:
        model = WhisperModel(model_size, device=device, compute_type=compute_type, cpu_threads=cpu_threads)
    except Exception as e:
        return {"error": f"Failed to load model '{model_size}': {str(e)}"}

    try:
        segments, info = model.transcribe(
            audio_file,
            language=language,
            task=task,
            beam_size=beam_size,
            best_of=best_of,
            temperature=temperature,
            vad_filter=vad_filter,
            vad_parameters=vad_parameters,
        )
    except Exception as e:
        return {"error": f"Transcription failed: {str(e)}"}

    # Build output
    result = {
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
        "duration_after_vad": info.duration_after_vad,
        "segments": [],
    }
    for seg in segments:
        seg_dict = {
            "start": seg.start,
            "end": seg.end,
            "text": seg.text,
            "avg_logprob": seg.avg_logprob,
            "no_speech_prob": seg.no_speech_prob,
            "temperature": seg.temperature,
            "compression_ratio": seg.compression_ratio,
        }
        # Optional word-level timestamps
        if seg.words:
            seg_dict["words"] = [
                {"word": word.word, "start": word.start, "end": word.end, "probability": word.probability}
                for word in seg.words
            ]
        result["segments"].append(seg_dict)

    return result

def main():
    input_data = parse_args()
    result = transcribe_audio(input_data)
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
```