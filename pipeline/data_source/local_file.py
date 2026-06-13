from pathlib import Path
from .base import DataSource

class LocalFileDataSource(DataSource):
    def __init__(self, path: str):
        self.path = Path(path)

    def load(self) -> bytes:
        if not self.path.exists():
            raise FileNotFoundError(f"File not found: {self.path}")
        if not self.path.is_file():
            raise IsADirectoryError(f"Path is a directory: {self.path}")
        return self.path.read_bytes()
