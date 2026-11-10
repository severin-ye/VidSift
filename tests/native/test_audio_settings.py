import unittest
from native import host


class AudioSettingsTests(unittest.TestCase):
    def test_settings_are_finite_enums(self):
        self.assertEqual(host.normalize_audio_settings({'bitrate':'8k','channels':'6','sourceBitrate':True}), {'bitrate':'64k','channels':'mono','sourceBitrate':64})
        self.assertEqual(host.normalize_audio_settings({'bitrate':'32k','channels':'keep','sourceBitrate':128})['bitrate'], '32k')

    def track(self, rate, identifier, **extra):
        return {'abr':rate, 'format_id':identifier, 'vcodec':'none', 'acodec':'aac', **extra}

    def test_selects_near_target_not_worst_or_video(self):
        tracks = [self.track(128,'high'),self.track(64,'speech'),self.track(8,'tiny'),self.track(48,'dub',language_preference=-10),self.track(32,'described',format_note='audio descriptive')]
        self.assertEqual(host.audio_format_selector(64, tracks)[0], 'speech')
        self.assertEqual(host.audio_format_selector(96, tracks)[0], 'speech')

    def test_no_small_or_unknown_candidate_is_honest(self):
        selector, note = host.audio_format_selector(64, [self.track(128,'only')])
        self.assertEqual(selector, 'only')
        self.assertIn('没有达到目标', note)
        selector, note = host.audio_format_selector(64, [self.track(None,'unknown')])
        self.assertEqual(selector, 'unknown')
        self.assertIn('无法确认', note)

    def test_unknown_original_bitrate_does_not_reintroduce_dub(self):
        tracks = [self.track(None, 'original', language='en', language_preference=10), self.track(64, 'dub', language='fr', language_preference=-10)]
        self.assertEqual(host.audio_format_selector(64, tracks)[0], 'original')

    def test_rejects_truncated_or_missing_completion_duration(self):
        self.assertEqual(host.validate_audio_duration('out_time_us=12010000\nprogress=end',12), 12.01)
        for value in ('', 'out_time_us=1000000\nprogress=end'):
            with self.assertRaises(ValueError):
                host.validate_audio_duration(value,12)
