```python
#!/usr/bin/env python3
"""
CLI bridge for sentence-transformers.
Accepts JSON via stdin or --input argument, outputs embeddings as JSON.
"""

import argparse
import json
import sys
from typing import List, Optional, Dict, Any

try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    print(json.dumps({"error": "sentence-transformers not installed. Run: pip install sentence-transformers"}), file=sys.stderr)
    sys.exit(1)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sentence embedding CLI bridge")
    parser.add_argument(
        "--model",
        default="all-MiniLM-L6-v2",
        help="SentenceTransformer model name (default: all-MiniLM-L6-v2)"
    )
    parser.add_argument(
        "--input",
        help="Path to JSON input file (if not provided, reads from stdin)"
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=32,
        help="Batch size for encoding (default: 32)"
    )
    parser.add_argument(
        "--normalize",
        action="store_true",
        default=True,
        help="Normalize embeddings to unit length (default: True)"
    )
    return parser.parse_args()


def read_input(args: argparse.Namespace) -> Dict[str, Any]:
    """Read and parse JSON input from file or stdin."""
    try:
        if args.input:
            with open(args.input, 'r', encoding='utf-8') as f:
                data = json.load(f)
        else:
            raw = sys.stdin.read()
            if not raw.strip():
                raise ValueError("No input provided via stdin")
            data = json.loads(raw)
        return data
    except FileNotFoundError as e:
        print(json.dumps({"error": f"Input file not found: {e}"}), file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"Input reading error: {str(e)}"}), file=sys.stderr)
        sys.exit(1)


def validate_input(data: Dict[str, Any]) -> List[str]:
    """Extract and validate texts from input JSON."""
    if "texts" in data and isinstance(data["texts"], list):
        texts = data["texts"]
    elif "sentences" in data and isinstance(data["sentences"], list):
        texts = data["sentences"]
    elif "documents" in data and isinstance(data["documents"], list):
        texts = data["documents"]
    else:
        # Assume the whole input is a list of strings
        if isinstance(data, list):
            texts = data
        else:
            raise ValueError("Input JSON must contain 'texts', 'sentences', or 'documents' key (list of strings), or be a list of strings.")

    # Validate all elements are strings
    if not all(isinstance(t, str) for t in texts):
        raise ValueError("All text entries must be strings.")
    if len(texts) == 0:
        raise ValueError("Input list is empty.")
    return texts


def load_model(model_name: str):
    """Load SentenceTransformer model with error handling."""
    try:
        model = SentenceTransformer(model_name)
        return model
    except Exception as e:
        print(json.dumps({"error": f"Failed to load model '{model_name}': {str(e)}"}), file=sys.stderr)
        sys.exit(1)


def encode_texts(model: SentenceTransformer, texts: List[str], batch_size: int, normalize: bool) -> List[List[float]]:
    """Generate embeddings for the list of texts."""
    try:
        embeddings = model.encode(
            texts,
            batch_size=batch_size,
            normalize_embeddings=normalize,
            show_progress_bar=False
        )
        # Convert numpy arrays to list of floats
        return [emb.tolist() for emb in embeddings]
    except Exception as e:
        print(json.dumps({"error": f"Encoding failed: {str(e)}"}), file=sys.stderr)
        sys.exit(1)


def main():
    args = parse_arguments()
    data = read_input(args)
    try:
        texts = validate_input(data)
    except ValueError as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

    model = load_model(args.model)
    embeddings = encode_texts(model, texts, args.batch_size, args.normalize)

    output = {
        "model": args.model,
        "input_count": len(texts),
        "embedding_dimension": len(embeddings[0]),
        "embeddings": embeddings,
    }
    # Pretty print JSON to stdout
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
```