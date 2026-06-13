```python
#!/usr/bin/env python3
"""
CLI bridge for extracting text from PDFs using pypdf.
Accepts JSON input via stdin or command-line argument with file path.
Outputs JSON with extracted text and metadata.
"""

import sys
import json
import argparse
from pathlib import Path

try:
    from pypdf import PdfReader
except ImportError:
    print(json.dumps({"status": "error", "message": "pypdf is not installed. Run: pip install pypdf"}))
    sys.exit(1)


def extract_pdf(file_path: str, pages: str = None) -> dict:
    """
    Extract text from PDF using pypdf.
    
    Args:
        file_path: Path to PDF file.
        pages: Page range(s) e.g., "1-3,5" or None for all.
    
    Returns:
        dict with status, metadata, extracted text per page.
    """
    try:
        path = Path(file_path)
        if not path.exists():
            return {"status": "error", "message": f"File not found: {file_path}"}
        if not path.is_file():
            return {"status": "error", "message": f"Not a file: {file_path}"}
        
        reader = PdfReader(path)
        total_pages = len(reader.pages)
        metadata = {
            "title": reader.metadata.title,
            "author": reader.metadata.author,
            "subject": reader.metadata.subject,
            "producer": reader.metadata.producer,
            "total_pages": total_pages,
        }
        
        # Parse page range if specified
        page_numbers = []
        if pages:
            for part in pages.split(','):
                part = part.strip()
                if '-' in part:
                    start, end = part.split('-', 1)
                    start = int(start.strip()) - 1  # convert to 0-index
                    end = int(end.strip()) - 1
                    if start < 0 or end >= total_pages or start > end:
                        return {
                            "status": "error",
                            "message": f"Invalid page range: {part}. PDF has {total_pages} pages (1-indexed)."
                        }
                    page_numbers.extend(range(start, end + 1))
                else:
                    num = int(part.strip()) - 1
                    if num < 0 or num >= total_pages:
                        return {
                            "status": "error",
                            "message": f"Invalid page number: {part}. PDF has {total_pages} pages."
                        }
                    page_numbers.append(num)
            # Remove duplicates and sort
            page_numbers = sorted(set(page_numbers))
        else:
            page_numbers = list(range(total_pages))
        
        extracted = {}
        for page_num in page_numbers:
            page = reader.pages[page_num]
            text = page.extract_text()
            extracted[str(page_num + 1)] = text  # 1-indexed keys
        
        return {
            "status": "success",
            "metadata": metadata,
            "pages": extracted,
            "extracted_pages": len(page_numbers),
            "file": file_path
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Extract text from PDF via CLI bridge")
    parser.add_argument('json_input', nargs='?', help='JSON string with "file_path" and optional "pages"')
    args = parser.parse_args()
    
    # Determine input source
    if args.json_input:
        input_str = args.json_input
    else:
        # Read from stdin if available and not a terminal
        if not sys.stdin.isatty():
            input_str = sys.stdin.read().strip()
        else:
            # No input provided
            print(json.dumps({"status": "error", "message": "No input provided. Pass JSON string or pipe to stdin."}))
            sys.exit(1)
    
    if not input_str:
        print(json.dumps({"status": "error", "message": "Empty input."}))
        sys.exit(1)
    
    # Parse JSON
    try:
        params = json.loads(input_str)
    except json.JSONDecodeError as e:
        print(json.dumps({"status": "error", "message": f"Invalid JSON: {e}"}))
        sys.exit(1)
    
    if 'file_path' not in params:
        print(json.dumps({"status": "error", "message": "Missing 'file_path' in input."}))
        sys.exit(1)
    
    file_path = params['file_path']
    pages = params.get('pages', None)
    
    result = extract_pdf(file_path, pages)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
```