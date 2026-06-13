import logging

logger = logging.getLogger(__name__)

def setup_logger():
    logging.basicConfig(level=logging.INFO, format='%(message)s')
