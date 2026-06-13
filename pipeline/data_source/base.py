from abc import ABC, abstractmethod

class DataSource(ABC):
    @abstractmethod
    def load(self) -> bytes:
        raise NotImplementedError
