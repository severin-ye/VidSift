import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from native import host


KEY = 'gsk_' + 'synthetic_test_only_' * 3


class GroqCredentialTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='vidsift-groq-credential-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for context in (patch.object(host, 'ROOT', self.root),
                        patch.object(Path, 'home', return_value=self.root),
                        patch.object(host, '_groq_windows', return_value=True),
                        patch.dict(os.environ, {}, clear=True)):
            context.start()
            self.addCleanup(context.stop)
        self.path = self.root / 'runtime' / 'credentials' / 'groq.dpapi'

    def response(self, status=200):
        response = MagicMock()
        response.status_code = status
        return response

    def test_missing_key_status_never_contains_secret(self):
        self.assertEqual(host.groq_key(), '')
        output = io.BytesIO()
        instance = host.Host(io.BytesIO(), output, self.root / 'cache')
        instance.dispatch({'id': 'status', 'action': 'groq_status'})
        output.seek(0)
        self.assertEqual(host.read_frame(output)['result'], {'configured': False})

    def test_external_precedence_and_store_does_not_mutate_external_keys(self):
        envfile = self.root / '.env'
        envfile.write_text('GROQ_API_KEY="file-value"\n', encoding='utf-8')
        self.assertEqual(host.groq_key(), 'file-value')
        with patch.dict(os.environ, {'GROQ_API_KEY': 'env-value'}), patch('requests.get') as send:
            self.assertEqual(host.groq_key(), 'env-value')
            self.assertEqual(host.groq_store_key({'apiKey': KEY}),
                             {'configured': True, 'existing': True, 'source': 'external'})
            self.assertEqual(os.environ['GROQ_API_KEY'], 'env-value')
            send.assert_not_called()
        self.assertEqual(envfile.read_text(encoding='utf-8'), 'GROQ_API_KEY="file-value"\n')
        self.assertFalse(self.path.exists())

    def test_bad_format_never_sends_or_persists(self):
        for key in (None, 1, '', 'other_' + 'x' * 40, 'gsk_short', KEY + '\n', KEY + ' ',
                    KEY + '\x00', KEY + '中', 'gsk_' + 'x' * 509):
            with self.subTest(key_type=type(key).__name__), patch('requests.get') as send:
                with self.assertRaisesRegex(ValueError, '格式') as error:
                    host.groq_store_key({'apiKey': key})
                self.assertNotIn(KEY, str(error.exception))
                send.assert_not_called()
                self.assertFalse(self.path.exists())

    def test_rejected_redirect_and_outage_never_persist_or_echo_response(self):
        for status in (401, 403, 302, 307, 429, 500, 204):
            response = self.response(status)
            response.text = KEY
            with self.subTest(status=status), patch('requests.get', return_value=response) as send:
                with self.assertRaises(ValueError) as error:
                    host.groq_store_key({'apiKey': KEY})
                self.assertNotIn(KEY, str(error.exception))
                send.assert_called_once()
                response.close.assert_called_once()
                self.assertFalse(self.path.exists())
        with patch('requests.get', side_effect=RuntimeError('Authorization Bearer ' + KEY)) as send:
            with self.assertRaises(ValueError) as error:
                host.groq_store_key({'apiKey': KEY})
            self.assertNotIn(KEY, str(error.exception))
            send.assert_called_once()
            self.assertFalse(self.path.exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows current-user DPAPI')
    def test_real_dpapi_roundtrip_and_fixed_validation_contract(self):
        response = self.response()
        with patch('requests.get', return_value=response) as send:
            self.assertEqual(host.groq_store_key({'apiKey': KEY}), {'configured': True})
        send.assert_called_once_with('https://api.groq.com/openai/v1/models',
                                     headers={'Authorization': 'Bearer ' + KEY},
                                     timeout=12, allow_redirects=False, stream=True)
        response.close.assert_called_once()
        encrypted = self.path.read_bytes()
        self.assertNotIn(KEY.encode('ascii'), encrypted)
        self.assertEqual(host.groq_key(), KEY)
        self.assertFalse(list(self.path.parent.glob('*.tmp')))
        output = io.BytesIO()
        instance = host.Host(io.BytesIO(), output, self.root / 'cache')
        instance.dispatch({'id': 'status', 'action': 'groq_status'})
        self.assertNotIn(KEY.encode('ascii'), output.getvalue())
        output.seek(0)
        self.assertEqual(host.read_frame(output)['result'], {'configured': True})

    @unittest.skipUnless(os.name == 'nt', 'Windows current-user DPAPI')
    def test_atomic_failure_preserves_previous_key_and_removes_temp(self):
        self.path.parent.mkdir(parents=True)
        original = host._groq_dpapi(KEY.encode('ascii'), protect=True)
        self.path.write_bytes(original)
        with patch('requests.get', return_value=self.response()), \
                patch.object(os, 'replace', side_effect=OSError(KEY)):
            with self.assertRaisesRegex(ValueError, '保存') as error:
                host.groq_store_key({'apiKey': 'gsk_' + 'another_test_only_' * 3})
        self.assertNotIn(KEY, str(error.exception))
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(host.groq_key(), KEY)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_corrupt_saved_key_is_safe_and_does_not_hide_external_key(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_bytes(b'not valid DPAPI data')
        self.assertEqual(host.groq_key(), '')
        with patch.dict(os.environ, {'GROQ_API_KEY': 'external'}):
            self.assertEqual(host.groq_key(), 'external')

    def test_encryption_failure_does_not_write_plaintext_or_leak(self):
        with patch('requests.get', return_value=self.response()), \
                patch.object(host, '_groq_dpapi', side_effect=RuntimeError(KEY)):
            with self.assertRaisesRegex(ValueError, '加密') as error:
                host.groq_store_key({'apiKey': KEY})
        self.assertNotIn(KEY, str(error.exception))
        self.assertFalse(self.path.exists())

    def test_non_windows_fails_without_network(self):
        with patch.object(host, '_groq_windows', return_value=False), patch('requests.get') as send:
            with self.assertRaisesRegex(ValueError, 'Windows'):
                host.groq_store_key({'apiKey': KEY})
        send.assert_not_called()

    def test_cancel_after_validation_does_not_save(self):
        job = host.Job('save')
        def validate(*args, **kwargs):
            job.cancel()
            return self.response()
        with patch('requests.get', side_effect=validate), patch.object(host, '_groq_dpapi') as encrypt:
            with self.assertRaises(host.Cancelled):
                host.groq_store_key({'apiKey': KEY}, job)
        encrypt.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_dispatch_store_is_async_and_result_contains_no_key(self):
        output = io.BytesIO()
        instance = host.Host(io.BytesIO(), output, self.root / 'cache')
        with patch.object(host, 'groq_store_key', return_value={'configured': True}) as store:
            instance.dispatch({'id': 'save', 'action': 'groq_store_key', 'apiKey': KEY})
            for thread in instance.threads:
                thread.join(2)
        store.assert_called_once()
        output.seek(0)
        self.assertEqual(host.read_frame(output), {'id': 'save', 'type': 'result', 'result': {'configured': True}})
        self.assertNotIn(KEY.encode(), output.getvalue())


if __name__ == '__main__':
    unittest.main()
