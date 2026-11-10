import importlib.util
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'diagnostics.py'
spec = importlib.util.spec_from_file_location('diagnostics', SCRIPT)
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


def var(n):
    out = bytearray()
    while n >= 128:
        out.append((n & 127) | 128)
        n >>= 7
    return bytes(out + bytes([n]))


def string(b):
    return var(len(b)) + b


def record(payload, kind=1):
    crc = d.mask_crc(d.crc32c(bytes([kind]) + payload))
    return struct.pack('<IHB', crc, len(payload), kind) + payload


def batch(seq, items):
    out = struct.pack('<QI', seq, len(items))
    for key, value in items:
        out += bytes([0 if value is None else 1]) + string(key.encode())
        if value is not None:
            out += string(json.dumps(value).encode())
    return out


def block(entries):
    out = b''
    for key, value in entries:
        out += var(0) + var(len(key)) + var(len(value)) + key + value
    return out + struct.pack('<II', 0, 1)


def table(entries, compressed=False):
    result = bytearray()
    def add(raw):
        offset = len(result)
        literal = bytes([(len(raw)-1) << 2]) if len(raw) < 61 else bytes([60 << 2, len(raw)-1])
        encoded = var(len(raw)) + literal + raw if compressed else raw
        typ = int(compressed)
        result.extend(encoded + bytes([typ]) + struct.pack('<I', d.mask_crc(d.crc32c(encoded + bytes([typ])))))
        return var(offset) + var(len(encoded))
    data_handle = add(block(entries))
    meta = add(block([]))
    index = add(block([(b'z', data_handle)]))
    footer = (meta + index).ljust(40, b'\0') + bytes.fromhex('57fb808b247547db')
    return bytes(result) + footer


class DiagnosticsTests(unittest.TestCase):
    def test_fragmented_wal_sequence_delete_and_privacy(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            # Exercise fragmentation across the actual 32 KiB physical boundary.
            payload = batch(5, [('customPrompt', 'PRIVATE' * 8000), ('vidsiftErrorLog', {'errors': [{'message': 'network failed https://x.test/a?token=SECRET', 'at': '2026-11-10'}]})])
            data = record(payload[:32761], 2) + record(payload[32761:40000], 3) + record(payload[40000:], 4)
            (p/'000001.log').write_bytes(data)
            report = d.read_store(p)
            self.assertIn('network failed', report['errors'][0]['message'])
            self.assertNotIn('SECRET', json.dumps(report))
            self.assertNotIn('PRIVATE', json.dumps(report))
            (p/'000002.log').write_bytes(record(batch(100, [('vidsiftErrorLog', None)])))
            self.assertEqual(d.read_store(p)['errors'], [])

    def test_manifest_ignores_obsolete_tables_and_logs(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            key = b'vidsiftLastTargetDiagnostic' + struct.pack('<Q', (4 << 8) | 1)
            (p/'000003.ldb').write_bytes(table([(key, b'{"reason":"current"}')]))
            (p/'000001.log').write_bytes(record(batch(100, [('vidsiftLastTargetDiagnostic', {'reason':'obsolete'})])))
            (p/'000099.ldb').write_bytes(table([(key[:-8]+struct.pack('<Q', (200 << 8)|1), b'{"reason":"obsolete"}')]))
            edit = var(2)+var(8)+var(7)+var(0)+var(3)+var(100)+string(key)+string(key)
            (p/'MANIFEST-000010').write_bytes(record(edit))
            (p/'CURRENT').write_bytes(b'MANIFEST-000010\n')
            self.assertEqual(d.read_store(p)['lastTarget']['reason'], 'current')

    def test_snappy_copy_and_crc_known_vector(self):
        self.assertEqual(d.crc32c(b'123456789'), 0xE3069283)
        self.assertEqual(d.snappy(var(9)+b'\x08abc\x16\x03\x00'), b'abcabcabc')
        with self.assertRaises(d.Corruption):
            d.snappy(var(9)+b'\x08abc\x16\x00\x00')

    def test_cli_epoch_since_and_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            values = [('vidsiftErrorLog', {'errors':[{'id':'old', 'at':1794182400000, 'message':'old'}, {'id':'new', 'at':1794355200000, 'message':'new'}]})]
            (p/'000001.log').write_bytes(record(batch(1, values)))
            proc = subprocess.run([sys.executable, str(SCRIPT), '--store', str(p), '--json', '--limit', '1', '--since', '2026-11-10T00:00:00Z'], capture_output=True, encoding='utf-8')
            parsed = json.loads(proc.stdout)
            self.assertEqual([x['id'] for x in parsed['profiles'][0]['errors']], ['new'])

    def test_snapshot_fails_after_two_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            calls = 0
            def unstable(path):
                nonlocal calls
                calls += 1
                return {'000001.log': (calls, calls)}
            (p/'000001.log').write_bytes(b'')
            with patch.object(d, 'file_signature', unstable):
                report = d.read_store(p)
            self.assertFalse(report['complete'])
            self.assertIn('both read attempts', report['warnings'][0])

    def test_sst_and_latest_wal_wins(self):
        for compressed in (False, True):
            with self.subTest(compressed=compressed), tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp)
                key = b'vidsiftLastTargetDiagnostic' + struct.pack('<Q', (4 << 8) | 1)
                (p/'000003.ldb').write_bytes(table([(key, b'{"reason":"old"}')], compressed))
                self.assertEqual(d.read_store(p)['lastTarget']['reason'], 'old')
                (p/'000001.log').write_bytes(record(batch(8, [('vidsiftLastTargetDiagnostic', {'reason':'latest'})])))
                self.assertEqual(d.read_store(p)['lastTarget']['reason'], 'latest')

    def test_corruption_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            broken = bytearray(record(batch(1, [('vidsiftErrorLog', {'errors': []})])))
            broken[-1] ^= 1
            (p/'000001.log').write_bytes(broken)
            report = d.read_store(p)
            self.assertFalse(report['complete'])
            self.assertTrue(any('CRC' in x for x in report['warnings']))

    def test_live_changes_retry_entire_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            f = p/'000001.log'
            f.write_bytes(record(batch(1, [('vidsiftLastTargetDiagnostic', {'reason':'before'})])))
            original = d.file_signature
            calls = 0
            def changing(path):
                nonlocal calls
                calls += 1
                if calls == 2:
                    f.write_bytes(record(batch(2, [('vidsiftLastTargetDiagnostic', {'reason':'after'})])))
                return original(path)
            with patch.object(d, 'file_signature', changing):
                report = d.read_store(p)
            self.assertEqual(report['lastTarget']['reason'], 'after')
            self.assertTrue(any('retried' in x for x in report['warnings']))

    def test_summary_does_not_export_private_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            values = [('videoLibraryState', {'videos':[{'id':'v', 'cover':'PRIVATE', 'customPrompt':'PRIVATE'}], 'tasks': []}), ('vidsiftTaskDiagnostics', {'tasks':[{'taskId':'t', 'message':'bad', 'customPrompt':'PRIVATE', 'audio':'PRIVATE'}]})]
            (p/'000001.log').write_bytes(record(batch(2, values)))
            report = d.read_store(p)
            self.assertEqual(report['library']['videoCount'], 1)
            self.assertEqual(report['tasks'][0]['taskId'], 't')
            self.assertNotIn('PRIVATE', json.dumps(report))

    def test_fallback_allowlist_and_error_id_deduplication(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            error = {'id':'same', 'at':123, 'message':'preserved reason'}
            values = [('vidsiftErrorLog', {'errors':[error]}), ('vidsiftErrorFallback.safe_123', {'errors':[error, {'id':'fallback', 'message':'fallback reason'}]}), ('vidsiftErrorFallback.unsafe/private', {'errors':[{'message':'PRIVATE'}]})]
            (p/'000001.log').write_bytes(record(batch(1, values)))
            report = d.read_store(p)
            self.assertEqual(len(report['errors']), 2)
            self.assertNotIn('PRIVATE', json.dumps(report))


if __name__ == '__main__':
    unittest.main()
