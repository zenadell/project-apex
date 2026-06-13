from pathlib import Path
from .base import DataSource
from config import DEFAULT_SOURCE

class FallbackDataSource(DataSource):
    def __init__(self):
        self.path = Path(DEFAULT_SOURCE)

    def load(self) -> bytes:
        # If the default file exists, load it; otherwise return empty bytes
        if self.path.exists() and self.path.is_file():
            return self.path.read_bytes()
        # For testing, we can return a placeholder
        return b"default sample content"
