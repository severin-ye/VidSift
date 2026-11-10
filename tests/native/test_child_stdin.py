"""Exercise the actual Windows Native Messaging pipe/worker interaction."""
import os
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from native import host


class NativeChildStdinTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows pipe inheritance regression')
    def test_child_starts_while_native_protocol_input_remains_open(self):
        fixture = Path(__file__).with_name('fixtures') / 'native_child_stdin.py'
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'child-started.txt'
            process = subprocess.Popen(
                [sys.executable, str(fixture), str(Path(host.__file__).resolve()), directory, str(marker)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            received = queue.Queue()

            def read_result():
                try:
                    received.put(host.read_frame(process.stdout))
                except Exception as error:
                    received.put(error)

            reader = threading.Thread(target=read_result, daemon=True)
            reader.start()
            try:
                # Keep this pipe open: closing it masks the original worker deadlock.
                host.write_frame(process.stdin, {'id': 'child-stdin', 'action': 'resolve'})
                try:
                    response = received.get(timeout=12)
                except queue.Empty:
                    self.fail('Native worker did not answer while protocol input remained open')
                self.assertIsInstance(response, dict)
                self.assertEqual(response.get('type'), 'result', response)
                self.assertEqual(response['result']['output'], 'child completed')
                self.assertTrue(marker.is_file(), 'Child interpreter never reached its code')
            finally:
                process.stdin.close()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                reader.join(timeout=2)
                process.stdout.close()
                process.stderr.close()


if __name__ == '__main__':
    unittest.main()
