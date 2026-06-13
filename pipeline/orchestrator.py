import logging
import requests
from .validators import is_empty_string, is_valid_file_path
from .data_source.local_file import LocalFileDataSource
from .data_source.network_file import NetworkFileDataSource
from .data_source.fallback import FallbackDataSource
from .logger import logger
from config import DEFAULT_SOURCE

class Pipeline:
    def __init__(self, data_source: str = None):
        self.data_source_str = data_source

    def run(self):
        source = self.data_source_str

        # Check if source is None or empty
        if source is None or is_empty_string(source):
            self._fallback()
            return

        # Check if source is a valid local file path
        if is_valid_file_path(source):
            data_source = LocalFileDataSource(source)
            try:
                data = data_source.load()
                self._process(data)
                return
            except (FileNotFoundError, IsADirectoryError) as e:
                self._fallback()
                return

        # Otherwise treat as network URL
        data_source = NetworkFileDataSource(source)
        try:
            data = data_source.load()
            self._process(data)
            return
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            self._fallback()
            return

    def _fallback(self):
        logger.info("No source provided – using sample.")
        data_source = FallbackDataSource()
        data = data_source.load()
        self._process(data)

    def _process(self, data: bytes):
        # Placeholder processing
        print(f"Processing {len(data)} bytes from data source.")
