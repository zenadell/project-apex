import os
from pathlib import Path

def is_empty_string(source: str) -> bool:
    return source is None or source.strip() == ''

def is_valid_file_path(source: str) -> bool:
    if not source:
        return False
    path = Path(source)
    return path.exists() and path.is_file()
