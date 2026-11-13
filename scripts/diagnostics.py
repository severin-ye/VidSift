#!/usr/bin/env python3
"""Read VidSift's allowlisted diagnostics from Chromium LevelDB, without opening it.

No dependencies, browser connection, locks, temporary snapshots, or database writes.
Exit 2 means a source could not be read completely; partial results carry warnings.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import struct
import sys

EXTENSION_ID = 'kggdkncbamdlhhihfkeldbbkppkgihad'
KEYS = {'vidsiftErrorLog', 'vidsiftTaskDiagnostics', 'videoLibraryState', 'vidsiftLastTargetDiagnostic', 'videoLibrarySettings'}
FALLBACK_KEY = re.compile(rb'vidsiftErrorFallback\.[A-Za-z0-9_-]{1,128}')
MAX_FILE = 128 * 1024 * 1024
MAX_SNAPSHOT = 512 * 1024 * 1024
MAX_VALUE = 32 * 1024 * 1024
MAGIC = bytes.fromhex('57fb808b247547db')


class Corruption(ValueError):
    pass


def varint(data, pos=0):
    value = 0
    for shift in range(0, 70, 7):
        if pos >= len(data):
            raise Corruption('truncated varint')
        b = data[pos]
        pos += 1
        value |= (b & 127) << shift
        if not b & 128:
            return value, pos
    raise Corruption('oversized varint')


def slice_string(data, pos):
    size, pos = varint(data, pos)
    if size > MAX_VALUE or pos + size > len(data):
        raise Corruption('invalid string length')
    return data[pos:pos + size], pos + size


def _crc_table():
    table = []
    for n in range(256):
        for _ in range(8):
            n = (n >> 1) ^ (0x82F63B78 if n & 1 else 0)
        table.append(n)
    return table


CRC_TABLE = _crc_table()


def crc32c(data):
    crc = 0xFFFFFFFF
    for b in data:
        crc = CRC_TABLE[(crc ^ b) & 255] ^ (crc >> 8)
    return crc ^ 0xFFFFFFFF


def mask_crc(crc):
    return (((crc >> 15) | (crc << 17)) + 0xA282EAD8) & 0xFFFFFFFF


def log_records(data):
    """LevelDB physical FULL/FIRST/MIDDLE/LAST records, with masked CRC32C."""
    pos, fragment = 0, None
    while pos < len(data):
        remaining = 32768 - pos % 32768
        if remaining < 7:
            if any(data[pos:pos + remaining]):
                raise Corruption('nonzero WAL padding')
            pos += remaining
            continue
        if len(data) - pos < 7:
            raise Corruption('truncated WAL header')
        crc, size, kind = struct.unpack_from('<IHB', data, pos)
        if crc == size == kind == 0:
            end = min(pos + remaining, len(data))
            if any(data[pos:end]):
                raise Corruption('invalid WAL padding')
            pos = end
            continue
        if size > remaining - 7 or pos + 7 + size > len(data):
            raise Corruption('truncated WAL record')
        payload = data[pos + 7:pos + 7 + size]
        pos += 7 + size
        if mask_crc(crc32c(bytes([kind]) + payload)) != crc:
            raise Corruption('WAL CRC mismatch')
        if kind == 1:
            if fragment is not None:
                raise Corruption('unfinished WAL fragment')
            yield payload
        elif kind == 2:
            if fragment is not None:
                raise Corruption('nested WAL fragment')
            fragment = bytearray(payload)
        elif kind in (3, 4):
            if fragment is None:
                raise Corruption('orphan WAL fragment')
            fragment.extend(payload)
            if len(fragment) > MAX_VALUE:
                raise Corruption('oversized WAL record')
            if kind == 4:
                yield bytes(fragment)
                fragment = None
        else:
            raise Corruption('unknown WAL record type')
    if fragment is not None:
        raise Corruption('truncated WAL fragments')


def write_batch(data):
    if len(data) < 12:
        raise Corruption('short WriteBatch')
    seq, count = struct.unpack_from('<QI', data)
    if count > MAX_VALUE or seq + count >= 1 << 56:
        raise Corruption('invalid WriteBatch count/sequence')
    pos = 12
    for offset in range(count):
        if pos >= len(data):
            raise Corruption('truncated WriteBatch')
        kind = data[pos]
        key, pos = slice_string(data, pos + 1)
        value = None
        if kind == 1:
            value, pos = slice_string(data, pos)
        elif kind != 0:
            raise Corruption('invalid WriteBatch operation')
        yield key, seq + offset, value
    if pos != len(data):
        raise Corruption('WriteBatch trailing bytes')


def snappy(data):
    size, pos = varint(data)
    if size > MAX_VALUE:
        raise Corruption('oversized Snappy output')
    out = bytearray()
    while pos < len(data):
        tag = data[pos]
        pos += 1
        kind = tag & 3
        if kind == 0:
            n = tag >> 2
            if n >= 60:
                width = n - 59
                if pos + width > len(data):
                    raise Corruption('short Snappy literal length')
                n = int.from_bytes(data[pos:pos + width], 'little')
                pos += width
            n += 1
            if pos + n > len(data) or len(out) + n > size:
                raise Corruption('invalid Snappy literal')
            out.extend(data[pos:pos + n])
            pos += n
        else:
            width = (1, 2, 4)[kind - 1]
            if pos + width > len(data):
                raise Corruption('short Snappy copy')
            offset = int.from_bytes(data[pos:pos + width], 'little')
            pos += width
            n = (4 + ((tag >> 2) & 7)) if kind == 1 else (1 + (tag >> 2))
            if kind == 1:
                offset |= (tag & 0xE0) << 3
            if offset == 0 or offset > len(out) or len(out) + n > size:
                raise Corruption('invalid Snappy copy')
            for _ in range(n):
                out.append(out[-offset])
    if len(out) != size:
        raise Corruption('Snappy length mismatch')
    return bytes(out)


def block_entries(data):
    if len(data) < 4:
        raise Corruption('short block')
    count = struct.unpack_from('<I', data, len(data) - 4)[0]
    end = len(data) - 4 - count * 4
    if count < 1 or end < 0:
        raise Corruption('invalid block restart count')
    restarts = [struct.unpack_from('<I', data, end + i * 4)[0] for i in range(count)]
    if restarts[0] != 0 or any(x > end for x in restarts) or restarts != sorted(restarts):
        raise Corruption('invalid block restart offsets')
    pos, previous = 0, b''
    while pos < end:
        shared, pos = varint(data, pos)
        length, pos = varint(data, pos)
        value_length, pos = varint(data, pos)
        if shared > len(previous) or length + value_length > MAX_VALUE or pos + length + value_length > end:
            raise Corruption('invalid block entry')
        key = previous[:shared] + data[pos:pos + length]
        pos += length
        value = data[pos:pos + value_length]
        pos += value_length
        previous = key
        yield key, value


def handle(data, pos=0):
    offset, pos = varint(data, pos)
    size, pos = varint(data, pos)
    return (offset, size), pos


def table_entries(data):
    if len(data) < 48 or data[-8:] != MAGIC:
        raise Corruption('invalid SST footer')
    _, pos = handle(data[-48:-8])
    index, _ = handle(data[-48:-8], pos)
    def read_block(h):
        offset, size = h
        if size > MAX_VALUE or offset + size + 5 > len(data) - 48:
            raise Corruption('invalid SST block bounds')
        raw, typ = data[offset:offset + size], data[offset + size]
        crc = struct.unpack_from('<I', data, offset + size + 1)[0]
        if mask_crc(crc32c(raw + bytes([typ]))) != crc:
            raise Corruption('SST CRC mismatch')
        if typ == 0:
            return raw
        if typ == 1:
            return snappy(raw)
        raise Corruption('unsupported SST compression')
    for _, encoded in block_entries(read_block(index)):
        h, consumed = handle(encoded)
        if consumed != len(encoded):
            raise Corruption('invalid SST index handle')
        for key, value in block_entries(read_block(h)):
            if len(key) < 8:
                raise Corruption('short SST internal key')
            tag = struct.unpack_from('<Q', key, len(key) - 8)[0]
            if tag & 255 not in (0, 1):
                raise Corruption('unknown SST internal value type')
            yield key[:-8], tag >> 8, value if tag & 255 else None


def manifest_files(data):
    """Replay VersionEdits to avoid resurrecting removed SSTs and obsolete logs."""
    tables, log, previous = set(), 0, 0
    for record in log_records(data):
        pos = 0
        while pos < len(record):
            tag, pos = varint(record, pos)
            if tag == 1:
                _, pos = slice_string(record, pos)
            elif tag in (2, 3, 4, 9):
                value, pos = varint(record, pos)
                if tag == 2:
                    log = value
                elif tag == 9:
                    previous = value
            elif tag == 5:
                _, pos = varint(record, pos)
                _, pos = slice_string(record, pos)
            elif tag in (6, 7):
                _, pos = varint(record, pos)
                number, pos = varint(record, pos)
                if tag == 6:
                    tables.discard(number)
                else:
                    _, pos = varint(record, pos)
                    _, pos = slice_string(record, pos)
                    _, pos = slice_string(record, pos)
                    tables.add(number)
            else:
                raise Corruption('unknown manifest VersionEdit tag')
    return tables, log, previous


def file_signature(path):
    return {f.name: (f.stat().st_size, f.stat().st_mtime_ns) for f in path.iterdir()
            if f.is_file() and (f.suffix in ('.log', '.ldb', '.sst') or f.name == 'CURRENT' or f.name.startswith('MANIFEST-'))}


def snapshot(path):
    for attempt in range(2):
        before = file_signature(path)
        if sum(x[0] for x in before.values()) > MAX_SNAPSHOT or any(x[0] > MAX_FILE for x in before.values()):
            raise Corruption('store exceeds read size budget')
        try:
            files = {}
            for name in before:
                with (path / name).open('rb') as stream:
                    files[name] = stream.read(MAX_FILE + 1)
                if len(files[name]) > MAX_FILE:
                    raise Corruption('file grew beyond read size budget')
            after = file_signature(path)
            if before == after and all(len(files[name]) == info[0] for name, info in before.items()):
                return files, attempt
        except FileNotFoundError:
            pass
    raise Corruption('store changed during both read attempts; close browser and retry')


def redact(value):
    text = str(value)
    text = re.sub(r'https?://[^\s<>"\']+', lambda m: re.sub(r'[?#].*', '?[redacted]', re.sub(r'//[^/@]+@', '//[redacted]@', m[0])), text)
    text = re.sub(r'(?i)\b(bearer|basic)\s+[a-z0-9+/_.=:-]+', r'\1 [redacted]', text)
    text = re.sub(r'(?i)(["\']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|secret|cookie)["\']?\s*[:=]\s*)[^\s,;]+', r'\1[redacted]', text)
    text = re.sub(r'(?i)\b(?:proxy-authorization|authorization|set-cookie|cookie)\s*[:=]\s*[^\r\n]+', '[credentials redacted]', text)
    text = re.sub(r'(?i)\b(?:customPrompt|prompt|transcript|audioData|mediaData)\s*[:=]\s*[^\r\n]+', '[content omitted]', text)
    text = re.sub(r'\beyJ[A-Za-z0-9_.=-]{16,}\b', '[redacted]', text)
    text = re.sub(r'\bsk-[A-Za-z0-9_-]{8,}\b', '[redacted]', text)
    return text[:4000]


META = {'id', 'at', 'version', 'component', 'taskId', 'tabId', 'category', 'message', 'reason', 'reasonText', 'text', 'error', 'errorMessage', 'status', 'state', 'stage', 'phase', 'code', 'startedAt', 'updatedAt', 'finishedAt', 'endedAt', 'createdAt', 'timestamp', 'platform', 'title', 'url', 'videoId', 'source', 'ok', 'success', 'count', 'attempt', 'durationMs', 'progress', 'event', 'type', 'name', 'diagnosticCode', 'cancelled', 'cancelReason'}
META.update({'elapsedMs', 'duration', 'bytes', 'originalBytes', 'outputBytes', 'audioCandidateCount', 'selectedSourceBytes', 'selectedSourceBitrate', 'attachmentIndex', 'cardCount', 'addedCardCount', 'audioReadyState', 'subtitleCount', 'imageCount', 'sourceTabId', 'targetTabId', 'targetTabIds', 'clickId', 'trackedCardPresent', 'busy', 'hasAudio', 'hasHTMLAudio', 'hasImage', 'hasTokenCount', 'playEnabled', 'runEnabled', 'promptFilled', 'accepted', 'active', 'ready', 'hasSubtitle', 'generating', 'hasResponse', 'hasTranscript', 'mime', 'errorName', 'subtitleStatus', 'audioSourceKind', 'attachedState', 'reasonCategory', 'nativeVersion'})
META.update({'checkedCount', 'pendingCount', 'unknownCount', 'candidateCount'})


def metadata(value, depth=0):
    if depth > 4:
        return '[truncated]'
    if isinstance(value, dict):
        return {k: metadata(v, depth + 1) for k, v in value.items() if k in META or k in ('details', 'events', 'history', 'diagnostics')}
    if isinstance(value, list):
        return [metadata(v, depth + 1) for v in value[-100:]]
    if isinstance(value, str):
        return redact(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return '[unsupported]'


def rows(value, name):
    if isinstance(value, dict):
        value = value.get(name, [])
    if isinstance(value, dict):
        value = list(value.values())
    return value if isinstance(value, list) else []


def timestamp(value):
    if isinstance(value, (int, float)):
        return value / 1000 if abs(value) > 1e11 else value
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return parsed.replace(tzinfo=dt.timezone.utc).timestamp() if parsed.tzinfo is None else parsed.timestamp()
    except (ValueError, OverflowError):
        return float('-inf')


def read_store(path, limit=50, since=None):
    path = Path(path)
    report = {'source': str(path), 'readAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'complete': True,
              'warnings': [], 'errors': [], 'tasks': [], 'library': None, 'lastTarget': None}
    try:
        files, retried = snapshot(path)
        if retried:
            report['warnings'].append('store changed once; retried entire snapshot successfully')
        active = None
        if 'CURRENT' in files:
            name = files['CURRENT'].decode('ascii').strip()
            if not re.fullmatch(r'MANIFEST-\d+', name) or name not in files:
                raise Corruption('CURRENT manifest missing or invalid')
            active = manifest_files(files[name])
        else:
            report['complete'] = False
            report['warnings'].append('CURRENT absent; synthetic/offline store includes all numbered files')
        selected = []
        for name, data in files.items():
            match = re.fullmatch(r'(\d+)\.(log|ldb|sst)', name)
            if not match:
                continue
            number, kind = int(match[1]), match[2]
            if active and ((kind == 'log' and number < active[1] and number != active[2]) or (kind != 'log' and number not in active[0])):
                continue
            selected.append((name, kind, data))
        if active:
            present = {int(Path(name).stem) for name, kind, _ in selected if kind != 'log'}
            if active[0] - present:
                raise Corruption('manifest references missing SST files')
        latest = {}
        for name, kind, data in sorted(selected):
            try:
                entries = (entry for record in log_records(data) for entry in write_batch(record)) if kind == 'log' else table_entries(data)
                for key, seq, raw in entries:
                    # Decode values only after matching an exact allowlisted byte key.
                    name_key = next((x for x in KEYS if key == x.encode('ascii')), None)
                    if name_key is None and FALLBACK_KEY.fullmatch(key):
                        name_key = key.decode('ascii')
                    if name_key and (name_key not in latest or seq > latest[name_key][0]):
                        latest[name_key] = (seq, raw)
                    elif name_key and seq == latest[name_key][0] and raw != latest[name_key][1]:
                        raise Corruption('conflicting values at same sequence')
            except (Corruption, struct.error) as exc:
                report['complete'] = False
                report['warnings'].append(f'{name}: {exc}')
        decoded = {}
        for key, (_, raw) in latest.items():
            if raw is not None:
                try:
                    decoded[key] = json.loads(raw.decode('utf-8'))
                except (ValueError, UnicodeError):
                    report['complete'] = False
                    report['warnings'].append(f'{key}: invalid JSON value')
        config = decoded.get('videoLibrarySettings')
        report['libraryConfig'] = None if not isinstance(config, dict) else {
            'enabled': config.get('enabled') if isinstance(config.get('enabled'), bool) else None,
            'reminderEnabled': config.get('reminderEnabled') if isinstance(config.get('reminderEnabled'), bool) else None,
            'extensionId': config.get('extensionId') if isinstance(config.get('extensionId'), str) and re.fullmatch('[a-p]{32}', config['extensionId']) else None,
        }
        errors = rows(decoded.get('vidsiftErrorLog', {}), 'errors')
        for key, value in decoded.items():
            if key.startswith('vidsiftErrorFallback.'):
                errors.extend(rows(value, 'errors'))
        unique_errors, seen = [], set()
        for error in errors:
            if not isinstance(error, dict):
                continue
            identity = error.get('id')
            if isinstance(identity, str) and identity in seen:
                continue
            if isinstance(identity, str):
                seen.add(identity)
            unique_errors.append(error)
        errors = unique_errors
        tasks = rows(decoded.get('vidsiftTaskDiagnostics', {}), 'tasks')
        def recent(items):
            items = [metadata(x) for x in items if isinstance(x, dict)]
            def when(x):
                return timestamp(x.get('at', x.get('updatedAt', x.get('timestamp', x.get('startedAt')))))
            if since:
                items = [x for x in items if when(x) >= timestamp(since)]
            return sorted(items, key=when, reverse=True)[:limit]
        report['errors'], report['tasks'] = recent(errors), recent(tasks)
        library = decoded.get('videoLibraryState')
        if isinstance(library, dict):
            videos, library_tasks = rows(library, 'videos'), rows(library, 'tasks')
            schema = library.get('schema', library.get('schemaVersion'))
            report['library'] = {'schema': schema if isinstance(schema, (int, float)) else None, 'videoCount': len(videos), 'taskCount': len(library_tasks), 'pendingCount': len(rows(library, 'pending')), 'coverPendingCount': len(rows(library, 'covers')), 'tasks': recent(library_tasks)}
            for field in ('message', 'lastSavedAt'):
                if isinstance(library.get(field), (str, int, float)):
                    report['library'][field] = redact(library[field])
        report['lastTarget'] = metadata(decoded.get('vidsiftLastTargetDiagnostic'))
    except (OSError, Corruption, UnicodeError, ValueError, struct.error) as exc:
        report['complete'] = False
        report['warnings'].append(redact(exc))
    return report


def detect_stores():
    base = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData' / 'Local'))
    result = []
    for root in (base / 'Microsoft/Edge/User Data', base / 'Google/Chrome/User Data'):
        if root.is_dir():
            for profile in sorted(root.iterdir()):
                store = profile / 'Local Extension Settings' / EXTENSION_ID
                if store.is_dir():
                    result.append(store)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', type=Path, help='explicit Local Extension Settings/<extension id> directory')
    parser.add_argument('--json', action='store_true', help='machine-readable report')
    parser.add_argument('--limit', type=int, default=50, help='maximum errors/tasks per profile (1-1000)')
    parser.add_argument('--since', help='ISO timestamp inclusive (UTC recommended)')
    args = parser.parse_args(argv)
    if not 1 <= args.limit <= 1000:
        parser.error('--limit must be between 1 and 1000')
    if args.since:
        try:
            dt.datetime.fromisoformat(args.since.replace('Z', '+00:00'))
        except ValueError:
            parser.error('--since must be an ISO date or timestamp')
    stores = [args.store] if args.store else detect_stores()
    reports = [read_store(p, args.limit, args.since) for p in stores]
    result = {'extensionId': EXTENSION_ID, 'readOnly': True, 'profiles': reports,
              'warnings': [] if stores else ['No VidSift Edge/Chrome extension store found; use --store.']}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for report in reports:
            print(f"Source: {report['source']}\nRead: {report['readAt']}\nComplete: {report['complete']}")
            for warning in report['warnings']:
                print(f'WARNING: {warning}')
            for name in ('errors', 'tasks', 'library', 'lastTarget'):
                print(f'{name}: {json.dumps(report[name], ensure_ascii=False, indent=2)}')
        for warning in result['warnings']:
            print(f'WARNING: {warning}')
    return 0 if reports and all(r['complete'] for r in reports) else 2


if __name__ == '__main__':
    # Preserve Chinese error reasons in redirected Windows CLI output.
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    raise SystemExit(main())
