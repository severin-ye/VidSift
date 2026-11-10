import io
import json
import tempfile
import threading
import time
import sys
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from native import host


class MediaResponse(io.BytesIO):
    def __init__(self, data, content_type='video/mp4', length=None, url='https://v.douyinvod.com/original.mp4'):
        super().__init__(data)
        self.headers = {'Content-Type': content_type, 'Content-Length': str(len(data) if length is None else length)}
        self.url = url

    def geturl(self):
        return self.url


class NativeTests(unittest.TestCase):
    def audio_download(self, directory, responses, video=False, job=None, progress=None):
        task = Path(directory)
        (task / 'douyin-source.json').write_text(json.dumps({'url': 'https://v.douyinvod.com/video.mp4', 'audioUrl': 'https://v.douyinvod.com/full.m4a'}))
        service = host.Service(task)
        with patch.object(host, 'build_opener') as opener, patch.object(service, 'ytdlp') as ytdlp:
            opener.return_value.open.side_effect = responses
            output = service.download('https://www.douyin.com/video/123', task, job or host.Job('audio'), video=video, progress=progress)
            urls = [call.args[0].full_url for call in opener.return_value.open.call_args_list]
            ytdlp.assert_not_called()
        return output, urls

    def test_douyin_full_audio_download_precedes_video(self):
        payload = b'\x00\x00\x00\x18ftypM4A full voice and music'
        progress = []
        with tempfile.TemporaryDirectory() as directory:
            output, urls = self.audio_download(directory, [MediaResponse(payload, 'audio/mp4')], progress=progress.append)
            self.assertEqual(urls, ['https://v.douyinvod.com/full.m4a'])
            self.assertEqual(output.name, 'original-audio.m4a')
            self.assertEqual(output.read_bytes(), payload)
        self.assertTrue(any('下载完整音轨' in text for text in progress))

    def test_douyin_full_audio_failure_uses_original_video(self):
        payload = b'\x00\x00\x00\x18ftypisomfull video'
        with tempfile.TemporaryDirectory() as directory:
            output, urls = self.audio_download(directory, [OSError('private URL'), MediaResponse(payload)])
            self.assertEqual(urls, ['https://v.douyinvod.com/full.m4a', 'https://v.douyinvod.com/video.mp4'])
            self.assertEqual(output.read_bytes(), payload)
            self.assertFalse((Path(directory) / 'original-audio.m4a.part').exists())

    def test_douyin_images_always_download_video(self):
        payload = b'\x00\x00\x00\x18ftypisomfull video'
        with tempfile.TemporaryDirectory() as directory:
            output, urls = self.audio_download(directory, [MediaResponse(payload)], video=True)
            self.assertEqual(urls, ['https://v.douyinvod.com/video.mp4'])
            self.assertEqual(output.name, 'video.mp4')

    def test_douyin_cancel_audio_and_video_never_tries_next_source(self):
        for stage in ('audio', 'video'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                service = host.Service(Path(directory))
                task = Path(directory)
                (task / 'douyin-source.json').write_text(json.dumps({'url': 'https://v.douyinvod.com/video.mp4', 'audioUrl': 'https://v.douyinvod.com/full.m4a'}))
                outcomes = [host.Cancelled('cancel')] if stage == 'audio' else [OSError('audio failed'), host.Cancelled('cancel')]
                with patch.object(service, 'download_douyin_media', side_effect=outcomes) as direct, patch.object(service, 'ytdlp') as fallback:
                    with self.assertRaises(host.Cancelled):
                        service.download('https://www.douyin.com/video/123', task, host.Job('cancel'))
                    self.assertEqual(direct.call_count, len(outcomes))
                    fallback.assert_not_called()

    def test_douyin_audio_url_uses_same_https_cdn_boundary(self):
        source = {'platform': 'douyin', 'videoId': '123', 'title': 'Current', 'duration': 12, 'douyin': {'videoId': '123', 'videoUrl': 'https://v.douyinvod.com/video.mp4'}}
        for audio_url in ['http://v.douyinvod.com/a', 'https://evil.test/a', 'https://zjcdn.com.evil.test/a', 'https://user:pass@v.douyinvod.com/a']:
            with self.subTest(audio_url=audio_url), self.assertRaises(ValueError):
                host.douyin_browser_source({**source, 'douyin': {**source['douyin'], 'audioUrl': audio_url}}, 'https://www.douyin.com/video/123')
        result = host.douyin_browser_source({**source, 'douyin': {**source['douyin'], 'audioUrl': 'https://v3-dy-o.zjcdn.com/audio.m4a'}}, 'https://www.douyin.com/video/123')
        self.assertEqual(result['_douyin_audio_url'], 'https://v3-dy-o.zjcdn.com/audio.m4a')

    def test_douyin_resolve_audio_cache_and_picture_requirement(self):
        source = {'platform': 'douyin', 'videoId': '123', 'title': 'Current', 'duration': 12, 'douyin': {'videoId': '123', 'videoUrl': 'https://v.douyinvod.com/video.mp4', 'audioUrl': 'https://v.douyinvod.com/full.m4a'}}
        for images in (False, True):
            with self.subTest(images=images), tempfile.TemporaryDirectory() as directory:
                service = host.Service(Path(directory))
                def download(url, task, job, video=False, progress=None):
                    self.assertEqual(video, images)
                    cache = json.loads((task / 'douyin-source.json').read_text())
                    self.assertEqual(cache['audioUrl'], source['douyin']['audioUrl'])
                    output = task / ('video.mp4' if video else 'original-audio.m4a')
                    output.write_bytes(b'fixture')
                    return output
                def convert(command, **kwargs):
                    Path(command[-1]).write_bytes(b'audio')
                    return 'out_time_us=12000000\nprogress=end', ''
                job = host.Job('resolve-audio')
                with patch.object(service, 'download', side_effect=download), patch.object(host, 'find_ffmpeg', return_value='ffmpeg'), patch.object(job, 'run', side_effect=convert), patch.object(service, 'screenshots', return_value=([], {})) as screenshots:
                    result = service.resolve({'url': 'https://www.douyin.com/video/123', 'source': source, 'needAudio': True, 'screenshots': {'enabled': images}}, job, lambda _: None)
                if images:
                    self.assertEqual(screenshots.call_args.args[0].name, 'video.mp4')
                else:
                    screenshots.assert_not_called()
                service.store.release([result['audio']['assetId']])

    def test_douyin_audio_then_video_failure_retries_platform_only_once(self):
        with tempfile.TemporaryDirectory() as directory:
            task = Path(directory)
            service = host.Service(task)
            (task / 'douyin-source.json').write_text(json.dumps({'url': 'https://v.douyinvod.com/video.mp4', 'audioUrl': 'https://v.douyinvod.com/full.m4a'}))
            def platform(url, task, job, args):
                self.assertEqual(url, 'https://www.douyin.com/video/123')
                self.assertEqual(args[args.index('-f') + 1], 'ba[abr>=32][abr<=64]/ba/b')
                output = task / 'platform.m4a'
                output.write_bytes(b'platform full audio')
                return str(output), ''
            with patch.object(service, 'download_douyin_media', side_effect=OSError('private')) as direct, patch.object(service, 'ytdlp', side_effect=platform) as fallback:
                result = service.download('https://www.douyin.com/video/123', task, host.Job('fallback'))
            self.assertEqual([call.args[0] for call in direct.call_args_list], ['https://v.douyinvod.com/full.m4a', 'https://v.douyinvod.com/video.mp4'])
            self.assertEqual(fallback.call_count, 1)
            self.assertEqual(result.read_bytes(), b'platform full audio')

    def direct_download(self, directory, response, job=None, progress=None):
        task = Path(directory)
        (task / 'douyin-source.json').write_text(json.dumps({'url': 'https://v.douyinvod.com/original.mp4?secret=private'}))
        service = host.Service(task)
        with patch.object(host, 'build_opener') as opener:
            opener.return_value.open.return_value = response
            result = service.download('https://www.douyin.com/video/123', task, job or host.Job('direct'), video=True, progress=progress)
            self.assertEqual(opener.return_value.open.call_args.kwargs['timeout'], 25)
        return result

    def test_direct_media_streams_all_chunks_and_safe_progress(self):
        payload = b'\x00\x00\x00\x18ftypisom' + b'x' * (host.CHUNK_SIZE * 3)
        progress = []
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(host.Service, 'ytdlp') as fallback:
                output = self.direct_download(directory, MediaResponse(payload), progress=progress.append)
            self.assertEqual(output.read_bytes(), payload)
            self.assertFalse(output.with_suffix('.mp4.part').exists())
            fallback.assert_not_called()
        self.assertTrue(any('100%' in text for text in progress))
        self.assertFalse(any('http' in text or 'private' in text for text in progress))

    def test_direct_media_rejects_truncated_and_html_responses(self):
        for data, content_type, length in [(b'\x00\x00\x00\x18ftypisom', 'video/mp4', 999), (b'<html>login</html>', 'text/html', 18), (b'<html>login</html>', 'video/mp4', 18)]:
            with self.subTest(content_type=content_type, length=length), tempfile.TemporaryDirectory() as directory:
                with patch.object(host.Service, 'ytdlp', side_effect=RuntimeError('platform failed')) as fallback:
                    with self.assertRaisesRegex(ValueError, '抖音原视频直连下载失败，作品链接回退也未成功'):
                        self.direct_download(directory, MediaResponse(data, content_type, length))
                self.assertEqual(fallback.call_count, 1)
                self.assertFalse((Path(directory) / 'video.mp4.part').exists())

    def test_direct_media_redirects_allow_only_verified_https_cdn(self):
        redirect = host.DouyinMediaRedirect()
        request = host.Request('https://v.douyinvod.com/original.mp4')
        for target in ['http://v.douyinvod.com/a', 'https://evil.test/a', 'https://v.douyinvod.com.evil.test/a']:
            with self.assertRaises(ValueError):
                redirect.redirect_request(request, None, 302, 'Found', {}, target)
        accepted = redirect.redirect_request(request, None, 302, 'Found', {}, 'https://v3-dy-o.zjcdn.com/a')
        self.assertEqual(accepted.full_url, 'https://v3-dy-o.zjcdn.com/a')

    def test_direct_media_cancel_removes_partial_without_fallback(self):
        job = host.Job('cancel-direct')
        payload = b'\x00\x00\x00\x18ftypisom' + b'x' * host.CHUNK_SIZE
        class CancelResponse(MediaResponse):
            def read(self, size=-1):
                data = super().read(size)
                job.cancel()
                return data
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(host.Service, 'ytdlp') as fallback:
                with self.assertRaises(host.Cancelled):
                    self.direct_download(directory, CancelResponse(payload), job)
                fallback.assert_not_called()
            self.assertFalse((Path(directory) / 'video.mp4.part').exists())

    def test_direct_failure_retries_original_platform_once(self):
        with tempfile.TemporaryDirectory() as directory:
            def fallback(url, task, job, args):
                self.assertEqual(url, 'https://www.douyin.com/video/123')
                self.assertNotIn('--force-generic-extractor', args)
                output = task / 'video.webm'
                output.write_bytes(b'platform video')
                return str(output), ''
            with patch.object(host.Service, 'ytdlp', side_effect=fallback) as retry:
                output = self.direct_download(directory, MediaResponse(b'html', 'text/html'))
            self.assertEqual(retry.call_count, 1)
            self.assertEqual(output.read_bytes(), b'platform video')

    def test_direct_media_revalidates_final_response_url(self):
        with tempfile.TemporaryDirectory() as directory:
            response = MediaResponse(b'\x00\x00\x00\x18ftypisom', url='https://evil.test/private')
            with patch.object(host.Service, 'ytdlp', side_effect=RuntimeError('platform failed')) as fallback:
                with self.assertRaisesRegex(ValueError, '抖音原视频直连下载失败，作品链接回退也未成功'):
                    self.direct_download(directory, response)
            self.assertEqual(fallback.call_count, 1)
            self.assertFalse((Path(directory) / 'video.mp4').exists())

    def test_direct_media_enforces_overall_timeout_and_cleans_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            service = host.Service(Path(directory))
            with patch.object(host, 'time') as clock, patch.object(host, 'build_opener') as opener:
                clock.monotonic.side_effect = [0, 0, 601]
                opener.return_value.open.return_value = MediaResponse(b'\x00\x00\x00\x18ftypisom')
                with self.assertRaisesRegex(TimeoutError, '600 秒'):
                    service.download_douyin_media('https://v.douyinvod.com/original.mp4', Path(directory), host.Job('timeout'))
            self.assertFalse((Path(directory) / 'video.mp4.part').exists())

    def test_direct_and_platform_failure_preserves_safe_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(host.Service, 'ytdlp', side_effect=host.MediaFailure('平台拒绝访问 HTTP 403', 1)):
                with self.assertRaisesRegex(ValueError, '抖音原视频直连下载失败，作品链接回退也未成功：平台拒绝访问 HTTP 403') as caught:
                    self.direct_download(directory, MediaResponse(b'<html>private</html>', 'text/html'))
            self.assertNotIn('http', str(caught.exception))
            self.assertNotIn('private', str(caught.exception))

    def test_observed_douyin_zjcdn_media_hosts(self):
        for name in ('v3-dy-o.zjcdn.com', 'v5-dy-ov-experiment.zjcdn.com'):
            url = 'https://' + name + '/original.mp4'
            self.assertEqual(host.validate_douyin_media_url(url), url)
        with self.assertRaises(ValueError):
            host.validate_douyin_media_url('https://v3-dy-o.zjcdn.com.evil.test/original.mp4')

    def test_current_douyin_browser_resource_downloads_original_and_skips_metadata(self):
        source = {'platform': 'douyin', 'videoId': '123', 'title': 'Current work', 'duration': 12,
                  'douyin': {'videoId': '123', 'videoUrl': 'https://v.douyinvod.com/original.mp4'},
                  'music': {'play_url': 'https://v.douyinvod.com/background.mp3'}}
        with tempfile.TemporaryDirectory() as directory:
            service = host.Service(Path(directory))
            job = host.Job('current')
            progress = []
            payload = b'\x00\x00\x00\x18ftypisomoriginal video'
            def convert(command, **kwargs):
                self.assertEqual(Path(command[command.index('-i') + 1]).read_bytes(), payload)
                Path(command[-1]).write_bytes(b'voice audio')
                return 'out_time_us=12000000\nprogress=end', ''
            with patch.object(service, 'extract') as extract, patch.object(service, 'ytdlp') as fallback, patch.object(host, 'build_opener') as opener, patch.object(host, 'find_ffmpeg', return_value='ffmpeg'), patch.object(job, 'run', side_effect=convert):
                opener.return_value.open.return_value = MediaResponse(payload)
                result = service.resolve({'url': 'https://www.douyin.com/jingxuan?modal_id=123', 'source': source, 'needAudio': True}, job, progress.append)
            extract.assert_not_called()
            fallback.assert_not_called()
            self.assertEqual(result['videoId'], '123')
            self.assertEqual(result['audio']['mime'], 'audio/mp4')
            self.assertTrue(any('页面原视频资源' in text for text in progress))
            self.assertTrue(any('包含人声' in text for text in progress))
            service.store.release([result['audio']['assetId']])
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_douyin_browser_resource_rejects_wrong_identity_and_untrusted_urls(self):
        valid = {'platform': 'douyin', 'videoId': '123', 'title': 'Current', 'duration': 12,
                 'douyin': {'videoId': '123', 'videoUrl': 'https://v.douyinvod.com/original.mp4'}}
        variants = []
        for field, value in [('videoId', '124'), ('platform', 'youtube'), ('title', ' '), ('duration', 0), ('duration', float('inf')), ('duration', True)]:
            variants.append({**valid, field: value})
        variants.append({**valid, 'douyin': {**valid['douyin'], 'videoId': '124'}})
        for url in ['https://douyinvod.com.evil.test/a', 'https://127.0.0.1/a', 'http://v.douyinvod.com/a', 'https://user:pass@v.douyinvod.com/a', 'https://v.douyinvod.com:444/a', 'https://v.douyinvod.com:bad/a']:
            variants.append({**valid, 'douyin': {**valid['douyin'], 'videoUrl': url}})
        with tempfile.TemporaryDirectory() as directory:
            service = host.Service(Path(directory))
            with patch.object(service, 'extract') as extract, patch.object(service, 'download') as download:
                for source in variants:
                    with self.subTest(source=source), self.assertRaisesRegex(ValueError, '抖音'):
                        service.resolve({'url': 'https://www.douyin.com/video/123', 'source': source, 'needAudio': True}, host.Job('reject'), lambda _: None)
                    self.assertEqual(list(Path(directory).iterdir()), [])
            extract.assert_not_called()
            download.assert_not_called()
        for domain in ('douyinvod.com', 'douyin.com', 'bytecdn.cn', 'ibytedtos.com', 'byteimg.com', 'pstatp.com'):
            self.assertEqual(host.validate_douyin_media_url('https://cdn.' + domain + ':443/video'), 'https://cdn.' + domain + ':443/video')

    def test_metadata_timeout_is_45_seconds_without_changing_download_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            service = host.Service(Path(directory))
            job = host.Job('limits')
            with patch.object(job, 'run', return_value=('{}', '')) as run:
                service.ytdlp('https://youtu.be/abcdefghijk', Path(directory), job, ['--dump-single-json', '--skip-download'])
                self.assertEqual(run.call_args.kwargs, {'timeout': 45})
                service.ytdlp('https://v.douyinvod.com/video.mp4', Path(directory), job, ['--force-generic-extractor'])
                self.assertEqual(run.call_args.kwargs, {})
            progress = []
            with patch.object(service, 'ytdlp', side_effect=TimeoutError('private signed URL')):
                with self.assertRaisesRegex(ValueError, 'YouTube.*45 秒') as caught:
                    service.extract('https://youtu.be/abcdefghijk', Path(directory), job, progress.append)
            self.assertNotIn('private', str(caught.exception))
            self.assertTrue(any('45 秒' in text for text in progress))

    def test_douyin_metadata_and_share_page_failures_preserve_stage_and_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            service = host.Service(Path(directory))
            progress = []
            with patch.object(service, 'ytdlp', side_effect=TimeoutError('private')), patch.object(host, 'build_opener') as opener:
                opener.return_value.open.side_effect = OSError('private signed URL')
                with self.assertRaisesRegex(ValueError, '抖音.*45 秒.*分享页.*25 秒') as caught:
                    service.extract('https://www.douyin.com/video/123', Path(directory), host.Job('fallback'), progress.append)
                self.assertEqual(opener.return_value.open.call_args.kwargs['timeout'], 25)
            self.assertNotIn('private', str(caught.exception))
            self.assertTrue(any('分享页' in text for text in progress))

    def test_douyin_without_browser_resource_still_extracts_and_rejects_wrong_work(self):
        with tempfile.TemporaryDirectory() as directory:
            service = host.Service(Path(directory))
            source = {'platform': 'douyin', 'videoId': '123', 'title': 'Known', 'duration': 12}
            with patch.object(service, 'extract', return_value={'id': '124', 'title': 'Wrong', 'duration': 12}) as extract:
                with self.assertRaisesRegex(ValueError, '作品编号'):
                    service.resolve({'url': 'https://www.douyin.com/video/123', 'source': source, 'forceAudio': True}, host.Job('wrong'), lambda _: None)
                extract.assert_called_once()
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_douyin_modal_route_uses_canonical_video_for_extraction(self):
        url = 'https://www.douyin.com/jingxuan/knowledge?modal_id=7695816752525053222'
        expected = 'https://www.douyin.com/video/7695816752525053222'
        with tempfile.TemporaryDirectory() as directory:
            service = host.Service(Path(directory))
            with patch.object(service, 'extract', return_value={'id': '7695816752525053222', 'title': 'video', 'duration': 10}) as extract:
                result = service.resolve({'url': url, 'needAudio': False}, host.Job('modal'), lambda _: None)
            self.assertEqual(extract.call_args.args[0], expected)
            self.assertEqual(result['videoId'], '7695816752525053222')

    def test_snippet_objects(self):
        class Snippet:
            start, duration, text = 1.25, 2.5, '字幕'
        self.assertEqual(host.transcript_body([Snippet()]), [{'from': 1.25, 'to': 3.75, 'content': '字幕'}])

    def test_interval_cap_and_validation(self):
        settings = host.Settings.parse({'enabled': True})
        times, interval = host.interval_times(10000, settings)
        self.assertLessEqual(len(times), 135)
        self.assertGreaterEqual(interval, 75)
        for value in [0, -1, float('nan'), float('inf')]:
            with self.assertRaises(ValueError):
                host.Settings.parse({'interval': value})

    def test_settings_match_extension_boundaries(self):
        settings = host.Settings.parse({'interval': .1, 'sceneThreshold': 0, 'width': 3840, 'height': 2160, 'rows': 3, 'columns': 3})
        self.assertEqual(settings.sceneThreshold, 0)
        self.assertEqual(settings.width, 3840)
        for field, value in [('interval', .09), ('interval', 3601), ('rows', 4), ('columns', 4), ('width', 159), ('height', 89), ('sceneThreshold', -.01)]:
            with self.assertRaises(ValueError, msg=field):
                host.Settings.parse({field: value})

    def test_urls(self):
        for url in ['file:///etc/passwd', 'https://youtube.com.evil.org/watch?v=x', 'http://127.0.0.1/', 'https://user:pw@youtube.com/watch?v=x']:
            with self.assertRaises(ValueError):
                host.validate_url(url)
        self.assertEqual(host.validate_url('https://youtu.be/abcdefghijk'), 'youtube')

    def test_binary_framing_and_limit(self):
        stream = io.BytesIO()
        host.write_frame(stream, {'id': 'a', 'text': '字幕'})
        stream.seek(0)
        self.assertEqual(host.read_frame(stream)['text'], '字幕')
        with self.assertRaises(ValueError):
            host.read_frame(io.BytesIO(b'\xff\xff\xff\xff'))
        with self.assertRaises(EOFError):
            host.read_frame(io.BytesIO(b'\x05\x00'))

    def test_assets_opaque_and_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = host.AssetStore(Path(tmp))
            task = store.new_task('task')
            file = task / 'audio.bin'
            file.write_bytes(b'a' * (host.CHUNK_SIZE + 10))
            asset = store.add(file, 'audio/mpeg')
            chunks = list(store.chunks(asset['assetId']))
            self.assertEqual([len(c) for c in chunks], [host.CHUNK_SIZE, 10])
            with self.assertRaises(ValueError):
                list(store.chunks('../audio.bin'))
            store.release([asset['assetId']])
            self.assertFalse(file.exists())
            store.cleanup(task)

    def test_no_media_download_when_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = host.Service(Path(tmp))
            metadata = {'id': 'abc', 'title': 'Test', 'duration': 100, 'subtitles': {}, 'automatic_captions': {}}
            with patch.object(service, 'extract', return_value=metadata), patch.object(service, 'youtube_subtitle', return_value=None), patch.object(service, 'download') as download:
                result = service.resolve({'id': 'x', 'url': 'https://youtu.be/abcdefghijk', 'needAudio': False, 'screenshots': {'enabled': False}}, host.Job('x'), lambda _: None)
            download.assert_not_called()
            self.assertIsNone(result['audio'])
            self.assertEqual(result['images'], [])

    def test_need_audio_is_fallback_and_force_skips_subtitles(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = host.Service(Path(tmp))
            request = {'id': 'x', 'url': 'https://youtu.be/abcdefghijk', 'needAudio': True, 'source': {'title': 'Current title', 'duration': 20, 'subtitle': {'body': [{'from': 0, 'to': 1, 'content': 'hello'}], 'lan': 'en'}}}
            with patch.object(service, 'extract') as metadata, patch.object(service, 'download') as download:
                result = service.resolve(request, host.Job('x'), lambda _: None)
            metadata.assert_not_called()
            download.assert_not_called()
            self.assertEqual(result['subtitle']['lan'], 'en')

    def test_transcript_attempted_before_metadata_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = host.Service(Path(tmp))
            subtitle = {'body': [{'from': 2, 'to': 4, 'content': '字幕'}], 'lan': 'zh-Hans'}
            with patch.object(service, 'youtube_subtitle', return_value=subtitle) as transcript, patch.object(service, 'extract', side_effect=host.MetadataFailure('YouTube：视频元数据解析超过 45 秒')), patch.object(service, 'download') as download:
                result = service.resolve({'url': 'https://youtu.be/abcdefghijk', 'needAudio': True}, host.Job('x'), lambda _: None)
            transcript.assert_called_once_with('abcdefghijk', unittest.mock.ANY)
            download.assert_not_called()
            self.assertEqual(result['subtitle'], subtitle)

    def test_force_audio_bypasses_subtitle_lookup(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = host.Service(Path(tmp))
            request = {'url': 'https://youtu.be/abcdefghijk', 'forceAudio': True, 'source': {'title': 'Test', 'duration': 3, 'subtitle': {'body': [], 'lan': 'en'}}}
            def download(url, task, job, video=False, progress=None):
                path = task / 'source.mp4'
                path.write_bytes(b'fixture')
                return path
            job = host.Job('audio')
            def convert(command, **kwargs):
                Path(command[-1]).write_bytes(b'audio')
                return 'out_time_us=3000000\nprogress=end', ''
            with patch.object(service, 'download', side_effect=download), patch.object(service, 'youtube_subtitle') as transcript, patch.object(host, 'find_ffmpeg', return_value='ffmpeg'), patch.object(job, 'run', side_effect=convert):
                result = service.resolve(request, job, lambda _: None)
            transcript.assert_not_called()
            self.assertIsNone(result['subtitle'])
            self.assertEqual(result['audio']['size'], 5)
            self.assertEqual(result['audio']['mime'], 'audio/mp4')
            service.store.release([result['audio']['assetId']])

    def test_process_origin_guard_and_diagnostics_native_frames(self):
        self.assertEqual(host.ORIGIN, 'chrome-extension://kggdkncbamdlhhihfkeldbbkppkgihad/')
        command = [sys.executable, str(Path(host.__file__))]
        denied = subprocess.run(command + ['chrome-extension://untrusted/'], capture_output=True)
        self.assertEqual(denied.returncode, 2)
        self.assertEqual(denied.stdout, b'')
        original = subprocess.run(command + ['chrome-extension://nigiglinogpocaonjlenipdhhlmnkmee/'], capture_output=True)
        self.assertEqual(original.returncode, 2)
        self.assertEqual(original.stdout, b'')
        stream = io.BytesIO()
        host.write_frame(stream, {'id': 'diag', 'action': 'diagnostics'})
        accepted = subprocess.run(command + [host.ORIGIN], input=stream.getvalue(), capture_output=True, timeout=10)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        result = host.read_frame(io.BytesIO(accepted.stdout))
        self.assertEqual(result['id'], 'diag')
        import json
        expected_version = json.loads((Path(__file__).resolve().parents[2] / 'package.json').read_text(encoding='utf-8'))['version']
        self.assertEqual(result['result']['version'], expected_version)
        self.assertIsInstance(result['result']['ffmpeg'], bool)

    def test_cancel_cleans_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = host.Service(Path(tmp))
            job = host.Job('x')
            job.cancel()
            with self.assertRaises(host.Cancelled):
                service.resolve({'id': 'x', 'url': 'https://youtu.be/abcdefghijk'}, job, lambda _: None)
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_douyin_original_video_not_music(self):
        data = {'aweme_detail': {'music': {'play_url': {'uri': 'https://music.example/a'}}, 'video': {'download_addr': {'url_list': ['https://v.douyinvod.com/original.mp4']}}}}
        self.assertEqual(host.douyin_video(data)[0], 'https://v.douyinvod.com/original.mp4')
        self.assertIsNone(host.douyin_video({'music': data['aweme_detail']['music']}))

    def test_uniform_scene_cap_across_timeline(self):
        values = host.uniform_cap(list(range(1000)), 135)
        self.assertEqual(len(values), 135)
        self.assertEqual((values[0], values[-1]), (0, 999))
        self.assertEqual(values, sorted(values))

    def test_media_error_redacts_signed_urls_and_login_data(self):
        error = host.MediaFailure(host.failure_category('HTTP Error 403: Forbidden https://video.example/token?secret=private Cookie: SESSDATA=private'), 1)
        self.assertIn('HTTP 403', str(error))
        self.assertNotIn('private', str(error))
        self.assertNotIn('SESSDATA', str(error))
        self.assertEqual(host.failure_category("Unknown encoder 'libmp3lame': Encoder not found"), 'FFmpeg 编解码或输入处理失败')

    def test_live_and_unknown_duration_stop_before_download(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = host.Service(Path(tmp))
            for info in [{'id': 'x', 'title': 'Live', 'duration': None, 'is_live': True}, {'id': 'x', 'title': 'Unknown', 'duration': None}, {'id': 'x', 'title': 'Invalid', 'duration': float('inf')}]:
                with patch.object(service, 'extract', return_value=info), patch.object(service, 'download') as download:
                    with self.assertRaises(ValueError):
                        service.resolve({'url': 'https://www.youtube.com/watch?v=abcdefghijk', 'forceAudio': True}, host.Job('invalid'), lambda _: None)
                download.assert_not_called()

    def test_montages_sorted_partial_and_fifteen_cap(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            service = host.Service(Path(tmp))
            task = service.store.new_task('grids')
            settings = host.Settings.parse({'enabled': True, 'width': 160, 'height': 90})
            frames = []
            for number in range(140):
                path = task / ('frame_%03d.png' % number)
                Image.new('RGB', (160, 90), (number, 0, 0)).save(path)
                frames.append((number, path))
            images = service.montages(list(reversed(frames)), settings, task, host.Job('grids'))
            self.assertEqual(len(images), 15)
            with Image.open(task / images[0]['name']) as grid:
                self.assertLess(grid.getpixel((80, 80))[0], 5)
            partial = service.montages(frames[:10], settings, task, host.Job('partial'))
            self.assertEqual(len(partial), 2)
            with Image.open(task / partial[-1]['name']) as grid:
                self.assertEqual(grid.size, (480, 90))
            service.store.cleanup(task)

    def test_subprocess_cancel_terminates_quickly(self):
        job = host.Job('sleep')
        errors = []
        def run():
            try:
                job.run([sys.executable, '-c', 'import time; time.sleep(30)'])
            except host.Cancelled:
                errors.append('cancelled')
        thread = threading.Thread(target=run)
        thread.start()
        time.sleep(.2)
        job.cancel()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, ['cancelled'])

    def test_host_responsive_cancel_and_chunk_sequence(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = io.BytesIO()
            native = host.Host(io.BytesIO(), output, Path(tmp))
            started = threading.Event()
            def resolving(request, job, progress):
                started.set()
                while not job.event.wait(.01):
                    pass
                job.check()
            with patch.object(native.service, 'resolve', side_effect=resolving):
                native.dispatch({'id': 'resolve', 'action': 'resolve'})
                self.assertTrue(started.wait(1))
                native.dispatch({'id': 'cancel', 'action': 'cancel', 'targetId': 'resolve'})
                native.threads[0].join(2)
            output.seek(0)
            events = []
            while event := host.read_frame(output):
                events.append(event)
            self.assertTrue(any(e['id'] == 'cancel' and e['type'] == 'result' for e in events))
            self.assertTrue(any(e['id'] == 'resolve' and e['type'] == 'error' for e in events))
            task = native.service.store.new_task('asset')
            file = task / 'asset.bin'
            file.write_bytes(b'x' * (host.CHUNK_SIZE + 1))
            asset = native.service.store.add(file, 'application/octet-stream')
            output.seek(0)
            output.truncate()
            native.dispatch({'id': 'read', 'action': 'read_asset', 'assetId': asset['assetId']})
            output.seek(0)
            chunks = [host.read_frame(output), host.read_frame(output)]
            self.assertEqual([c['sequence'] for c in chunks], [0, 1])
            self.assertEqual(host.read_frame(output)['result']['size'], host.CHUNK_SIZE + 1)
            native.service.store.cleanup(task)

    @unittest.skipUnless(host.find_ffmpeg(), 'FFmpeg is unavailable')
    def test_ffmpeg_synthetic_scene_fallback_and_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = host.Service(Path(tmp))
            task = service.store.new_task('fixture')
            video = task / 'fixture.mp4'
            job = host.Job('fixture')
            job.run([host.find_ffmpeg(), '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=3', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=3', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', '-y', str(video)])
            warnings = []
            settings = host.Settings.parse({'enabled': True, 'interval': 1, 'width': 160, 'height': 90})
            images, info = service.screenshots(video, 3, settings, task, job, lambda _: None, warnings)
            self.assertEqual(info['mode'], 'interval')
            self.assertEqual(info['frameCount'], 3)
            self.assertEqual(len(images), 1)
            self.assertTrue(warnings)
            def download(url, target, job, video=False, progress=None):
                copy = target / 'source.mp4'
                import shutil
                shutil.copyfile(task / 'fixture.mp4', copy)
                return copy
            with patch.object(service, 'download', side_effect=download):
                result = service.resolve({'url': 'https://www.youtube.com/watch?v=abcdefghijk', 'forceAudio': True, 'source': {'title': 'Synthetic audio', 'duration': 3}}, host.Job('audio-fixture'), lambda _: None)
            path, metadata = service.store.lookup(result['audio']['assetId'])
            self.assertEqual(metadata['mime'], 'audio/mp4')
            self.assertGreater(metadata['size'], 1000)
            self.assertEqual(path.suffix, '.m4a')
            service.store.release([metadata['assetId']])
            service.store.cleanup(task)


if __name__ == '__main__':
    unittest.main()
