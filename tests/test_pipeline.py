import pytest
from unittest.mock import patch, MagicMock
from pipeline.orchestrator import Pipeline
from pipeline.data_source.fallback import FallbackDataSource
from config import DEFAULT_SOURCE

class TestPipeline:
    def test_no_source_provided(self, capsys):
        pipeline = Pipeline(data_source=None)
        pipeline.run()
        captured = capsys.readouterr()
        assert 'No source provided – using sample.' in captured.out

    def test_empty_string_source(self, capsys):
        pipeline = Pipeline(data_source='')
        pipeline.run()
        captured = capsys.readouterr()
        assert 'No source provided – using sample.' in captured.out

    def test_invalid_file_fallback(self, capsys):
        pipeline = Pipeline(data_source='nonexistent.pdf')
        pipeline.run()
        captured = capsys.readouterr()
        assert 'Falling back to default' in captured.out

    def test_network_timeout_fallback(self, capsys):
        with patch('pipeline.data_source.network_file.requests.get') as mock_get:
            mock_get.side_effect = TimeoutError('Timeout')
            pipeline = Pipeline(data_source='http://example.com/test.pdf')
            pipeline.run()
            captured = capsys.readouterr()
            assert 'Falling back to default' in captured.out

    def test_success_file(self, tmp_path, capsys):
        d = tmp_path / 'test.pdf'
        d.write_text('dummy pdf content')
        pipeline = Pipeline(data_source=str(d))
        pipeline.run()
        captured = capsys.readouterr()
        assert 'Pipeline processed' in captured.out

    def test_success_url(self, capsys):
        with patch('pipeline.data_source.network_file.requests.get') as mock_get:
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.content = b'dummy pdf content'
            mock_get.return_value = mock_response
            pipeline = Pipeline(data_source='http://example.com/test.pdf')
            pipeline.run()
            captured = capsys.readouterr()
            assert 'Pipeline processed' in captured.out
