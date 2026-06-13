import os
from unittest.mock import patch

import pytest

from camera_capture import unified_camera_capture


class TestUnifiedCapture:
    @patch.dict(os.environ, {"CAMERA_MOCK": "true"}, clear=True)
    def test_mock_driver_returns_bytes(self):
        """Mock driver should return non‑empty bytes."""
        data = unified_camera_capture(resolution="640x480", fmt="jpeg")
        assert isinstance(data, bytes)
        assert len(data) > 0

    @patch.dict(os.environ, {"CAMERA_MOCK": "true"}, clear=True)
    def test_mock_driver_respects_format(self):
        """PNG format should produce a PNG header."""
        data = unified_camera_capture(resolution="640x480", fmt="png")
        # PNG magic bytes: 89 50 4E 47
        assert data[:4] == b"\x89PNG"

    @patch.dict(os.environ, {"CAMERA_MOCK": "true"}, clear=True)
    def test_output_path_writes_file(self, tmp_path):
        """When output_path is given, the file should be created."""
        out = tmp_path / "test.jpg"
        data = unified_camera_capture(
            resolution="320x240", fmt="jpeg", output_path=str(out)
        )
        assert out.exists()
        assert out.stat().st_size == len(data)

    @patch.dict(os.environ, {"CAMERA_MOCK": "false"}, clear=True)
    def test_real_driver_raises_without_camera(self):
        """Without a real camera, RealCameraDriver should raise."""
        with pytest.raises(RuntimeError, match="Cannot open camera"):
            unified_camera_capture(resolution="640x480", fmt="jpeg")
