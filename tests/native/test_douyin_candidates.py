import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from native import host

class DouyinCandidateTests(unittest.TestCase):
    def source(self):
        return {'platform':'douyin','videoId':'123','title':'Work','duration':100,'douyin':{'videoId':'123','videoUrl':'https://v.douyinvod.com/video.mp4'}}

    def test_estimated_size_competes_with_metadata_and_mirrors_precede_video(self):
        resource={'audioCandidates':[{'size':2000000,'urls':['https://v.douyinvod.com/big']},{'bitrate':64000,'urls':['https://v.douyinvod.com/small1','https://v.douyinvod.com/small2']}]}
        candidates=host.douyin_audio_candidates(resource,100)
        self.assertEqual(candidates[0]['expectedBytes'],800000)
        with tempfile.TemporaryDirectory() as directory:
            task=Path(directory); service=host.Service(task)
            (task/'douyin-source.json').write_text(json.dumps({**resource,'duration':100,'url':'https://v.douyinvod.com/video.mp4'}))
            output=task/'original-audio.m4a';output.write_bytes(b'audio')
            with patch.object(service,'download_douyin_media',side_effect=[OSError('mirror'),output]) as download:
                self.assertEqual(service.download('https://www.douyin.com/video/123',task,host.Job('candidate')),output)
            self.assertEqual([c.args[0] for c in download.call_args_list],candidates[0]['urls'])
            self.assertEqual(json.loads((task/'audio-choice.json').read_text())['candidateCount'],2)

    def test_injected_candidates_and_bad_sizes_are_rejected(self):
        for value in (-1, True, float('inf'), '100'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                host.douyin_audio_candidates({'audioCandidates':[{'size':value,'urls':['https://v.douyinvod.com/a']}]},100)
        with self.assertRaises(ValueError):
            host.douyin_audio_candidates({'audioCandidates':[{'urls':['https://evil.test/a']}]},100)
        with self.assertRaises(ValueError):
            host.douyin_audio_candidates({'audioCandidates':[{'urls':['https://v.douyinvod.com/a']}]*13},100)

    def test_srt_vtt_inline_json_and_invalid_cues(self):
        for ext,text in [('srt','1\n00:00:01,200 --> 00:00:02,400\n口播\n'),('vtt','WEBVTT\n\n00:01.200 --> 00:02.400\n口播\n')]:
            body=host.subtitle_body(text,ext);self.assertEqual(body,[{'from':1.2,'to':2.4,'content':'口播'}])
        self.assertEqual(host.subtitle_body({'utterances':[{'start_time':1200,'end_time':2400,'text':'口播'}]},'json')[0]['to'],2.4)
        self.assertEqual(host.subtitle_body({'body':[{'from':2,'to':1,'content':'wrong'},{'from':0,'to':1,'content':''}]},'json'),[])

    def test_native_inline_caption_priority_avoids_audio_and_metadata(self):
        source=self.source();source['subtitle']={'body':[{'from':0,'to':2,'content':'完整字幕'}]}
        with tempfile.TemporaryDirectory() as directory:
            service=host.Service(Path(directory))
            with patch.object(service,'download') as download,patch.object(service,'extract') as extract:
                result=service.resolve({'url':'https://www.douyin.com/video/123','source':source,'needAudio':True},host.Job('captions'),lambda _:None)
            download.assert_not_called();extract.assert_not_called();self.assertEqual(result['subtitleStatus'],'available')

    def test_subtitle_tracks_inline_srt_parse_and_missing_stays_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            service=host.Service(Path(directory))
            result=service.subtitle_fallback({'subtitles':{'zh':[{'ext':'srt','data':'1\n00:00:00,000 --> 00:00:01,000\n字幕'}]}},host.Job('subs'))
            self.assertEqual(result['body'][0]['content'],'字幕')
            source=self.source()
            info=host.douyin_browser_source(source,'https://www.douyin.com/video/123')
            self.assertEqual(info['_subtitle_status'],'unknown')

    def test_audio_attempt_budget_and_cancel_preserve_fallback_boundary(self):
        for cancel in (False, True):
            with self.subTest(cancel=cancel), tempfile.TemporaryDirectory() as directory:
                task=Path(directory);service=host.Service(task)
                urls=['https://v.douyinvod.com/a'+str(i) for i in range(6)]
                resource={'url':'https://v.douyinvod.com/video.mp4','duration':100,'audioCandidates':[{'size':100,'urls':urls[:3]},{'size':200,'urls':urls[3:]}]}
                (task/'douyin-source.json').write_text(json.dumps(resource))
                output=task/'video.mp4';output.write_bytes(b'video')
                effects=[host.Cancelled('cancel')] if cancel else [OSError('network')]*3+[output]
                with patch.object(service,'download_douyin_media',side_effect=effects) as download:
                    if cancel:
                        with self.assertRaises(host.Cancelled):service.download('https://www.douyin.com/video/123',task,host.Job('budget'))
                        self.assertEqual(download.call_count,1)
                    else:
                        service.download('https://www.douyin.com/video/123',task,host.Job('budget'))
                        self.assertEqual([c.args[0] for c in download.call_args_list],urls[:3]+[resource['url']])

    def test_browser_track_urls_cannot_escape_cdn_or_cross_work(self):
        source=self.source();source['douyin']['subtitleTracks']=[{'url':'https://evil.test/caption.vtt','ext':'vtt'}]
        with self.assertRaises(ValueError):host.douyin_browser_source(source,'https://www.douyin.com/video/123')
        source=self.source();source['douyin']['videoId']='999'
        with self.assertRaises(ValueError):host.douyin_browser_source(source,'https://www.douyin.com/video/123')
