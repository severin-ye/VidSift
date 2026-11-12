import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from native import host


class GroqPlatformTests(unittest.TestCase):
    platforms = [('bilibili', 'BV1abc123456', 'https://www.bilibili.com/video/BV1abc123456'),
                 ('youtube', 'abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk'),
                 ('douyin', '123', 'https://www.douyin.com/video/123')]

    def request(self, platform, video_id, url, subtitle=None):
        source = {'videoId': video_id, 'title': 'Current', 'duration': 10}
        if subtitle: source['subtitle'] = subtitle
        if platform == 'douyin':
            source.update(platform=platform, douyin={'videoId': video_id, 'videoUrl': 'https://v.douyinvod.com/original.mp4'})
        return {'url': url, 'source': source, 'localTranscription': True}

    def test_all_platforms_prefer_existing_subtitles_without_downloading(self):
        subtitle = {'body': [{'from': 0, 'to': 1, 'content': 'Existing'}], 'lan': 'en'}
        for platform, video_id, url in self.platforms:
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                service = host.Service(Path(directory))
                with patch.object(service, 'download') as download, patch.object(service, 'extract') as extract:
                    result = service.resolve(self.request(platform, video_id, url, subtitle), host.Job('subtitle'), lambda _: None)
                download.assert_not_called(); extract.assert_not_called()
                self.assertTrue(result['subtitle']); self.assertNotIn('localAudio', result)

    def test_all_platforms_keep_full_original_audio_in_native(self):
        for platform, video_id, url in self.platforms:
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                service = host.Service(Path(directory)); job = host.Job('resolve')
                def download(url, task, job, **kwargs):
                    path = task / 'original.media'; path.write_bytes(b'full-source'); return path
                with patch.object(service, 'extract', return_value={}), patch.object(service, 'youtube_subtitle', return_value=None), patch.object(service, 'download', side_effect=download), patch.object(host, 'find_ffmpeg', return_value='ffmpeg'), patch.object(job, 'run', return_value=('', 'Duration: 00:00:10.00')) as run:
                    result = service.resolve(self.request(platform, video_id, url), job, lambda _: None)
                descriptor = result['localAudio']
                self.assertEqual(descriptor['platform'], platform)
                self.assertEqual(descriptor['duration'], 10)
                self.assertNotIn('base64', json.dumps(result))
                self.assertEqual(service.local_audio.lookup(descriptor['fingerprint'])[0].read_bytes(), b'full-source')
                self.assertEqual(run.call_count, 1)  # Probe only; no truncated conversion.
                with patch.object(job, 'run', return_value=(json.dumps({'error': 'Groq HTTP 429'}), '')) as transcribe:
                    with self.assertRaisesRegex(ValueError, '429'):
                        service.transcribe_groq(descriptor, job, lambda _: None)
                self.assertEqual(transcribe.call_count, 1)
                self.assertIn('--groq-worker', transcribe.call_args.args[0])
                service.local_audio.finish(descriptor['fingerprint'], 'failed')
                self.assertFalse(service.local_audio.load(descriptor['fingerprint'])['leases'])

    def test_discovered_subtitles_also_prevent_local_audio_download(self):
        subtitle = {'body': [{'from': 0, 'to': 1, 'content': 'Discovered'}], 'lan': 'en'}
        for platform, video_id, url in self.platforms[:2]:
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                service = host.Service(Path(directory))
                with patch.object(service, 'youtube_subtitle', return_value=subtitle), patch.object(service, 'extract', return_value={}), patch.object(service, 'subtitle_fallback', return_value=subtitle), patch.object(service, 'download') as download:
                    result = service.resolve(self.request(platform, video_id, url), host.Job('discover'), lambda _: None)
                download.assert_not_called()
                self.assertEqual(result['subtitle'], subtitle)
                self.assertIsNone(result['audio'])

    def test_cross_platform_identity_and_legacy_douyin_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = host.LocalAudioCache(Path(directory), 'first')
            path = Path(directory) / 'source'; path.write_bytes(b'identical')
            descriptors = [cache.add(path, '123', 10, {}, platform=platform) for platform, _, _ in self.platforms]
            self.assertEqual(len({item['fingerprint'] for item in descriptors}), 3)
            douyin = descriptors[-1]
            expected = hashlib.sha256(('123:' + host.file_hash(path)).encode()).hexdigest()
            self.assertEqual(douyin['fingerprint'], expected)
            entry = cache.load(expected); entry.pop('platform', None); cache.save(entry)
            second = host.LocalAudioCache(Path(directory), 'second')
            self.assertEqual(second.claim(expected, '123')['platform'], 'douyin')
            with self.assertRaisesRegex(ValueError, '平台'):
                second.claim(expected, '123', 'youtube')
            service = host.Service(Path(directory)); service.local_audio = cache
            with self.assertRaisesRegex(ValueError, '平台'):
                service.transcribe_groq({**descriptors[0], 'platform': 'youtube'}, host.Job('wrong'), lambda _: None)

    def test_short_source_is_rejected_before_publishing_cache(self):
        for platform, video_id, url in self.platforms:
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                service = host.Service(Path(directory)); job = host.Job('short')
                def download(url, task, job, **kwargs):
                    path = task / 'original.media'; path.write_bytes(b'preview'); return path
                with patch.object(service, 'extract', return_value={}), patch.object(service, 'youtube_subtitle', return_value=None), patch.object(service, 'download', side_effect=download), patch.object(host, 'find_ffmpeg', return_value='ffmpeg'), patch.object(job, 'run', return_value=('', 'Duration: 00:00:03.00')):
                    with self.assertRaisesRegex(ValueError, '时长'):
                        service.resolve(self.request(platform, video_id, url), job, lambda _: None)
                self.assertFalse(list(service.local_audio.root.glob('*.media')))

    def test_cancel_after_cache_publish_releases_lease_without_deleting_retry_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            service = host.Service(Path(directory)); job = host.Job('cancel')
            platform, video_id, url = self.platforms[1]
            original_add = service.local_audio.add
            def add(*args, **kwargs):
                descriptor = original_add(*args, **kwargs); job.cancel(); return descriptor
            def download(url, task, job, **kwargs):
                path = task / 'original.media'; path.write_bytes(b'full-source'); return path
            with patch.object(service, 'extract', return_value={}), patch.object(service, 'youtube_subtitle', return_value=None), patch.object(service, 'download', side_effect=download), patch.object(host, 'find_ffmpeg', return_value='ffmpeg'), patch.object(job, 'run', return_value=('', 'Duration: 00:00:10.00')), patch.object(service.local_audio, 'add', side_effect=add):
                with self.assertRaises(host.Cancelled):
                    service.resolve(self.request(platform, video_id, url), job, lambda _: None)
            entries = list(service.local_audio.root.glob('*.json'))
            self.assertEqual(len(entries), 1)
            entry = service.local_audio.load(entries[0].stem)
            self.assertEqual(entry['status'], 'cancelled'); self.assertFalse(entry['leases'])
            descriptor = service.local_audio.claim(entry['fingerprint'], video_id, platform)
            self.assertEqual(service.local_audio.lookup(descriptor['fingerprint'])[0].read_bytes(), b'full-source')


if __name__ == '__main__': unittest.main()
