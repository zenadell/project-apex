import os
import subprocess
import sys

import pytest


class TestIntegration:
    @pytest.fixture(autouse=True)
    def mock_env(self):
        """Ensure mock camera is used for integration tests."""
        os.environ["CAMERA_MOCK"] = "true"
        yield
        os.environ.pop("CAMERA_MOCK", None)

    def test_script_creates_output_file(self, tmp_path):
        """Running capture_script.py with --output should create a file."""
        out = tmp_path / "capture.jpg"
        result = subprocess.run(
            [
                sys.executable,
                "capture_script.py",
                "--resolution", "320x240",
                "--format", "jpeg",
                "--output", str(out),
            ],
            capture_output=True,
            text=True,
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert out.exists(), f"Output file {out} was not created"
        assert out.stat().st_size > 0

    def test_script_prints_bytes_without_output(self):
        """Running without --output should print byte count."""
        result = subprocess.run(
            [
                sys.executable,
                "capture_script.py",
                "--resolution", "320x240",
                "--format", "jpeg",
            ],
            capture_output=True,
            text=True,
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )
        assert result.returncode == 0
        assert "Captured" in result.stdout
        assert "bytes" in result.stdout
