import requests
from .base import DataSource
from config import TIMEOUT

class NetworkFileDataSource(DataSource):
    def __init__(self, url: str):
        self.url = url

    def load(self) -> bytes:
        try:
            response = requests.get(self.url, timeout=TIMEOUT)
            response.raise_for_status()
            return response.content
        except requests.exceptions.Timeout:
            raise TimeoutError(f"Network timeout for {self.url}")
        except requests.exceptions.RequestException as e:
            raise ConnectionError(f"Network error for {self.url}: {e}")
