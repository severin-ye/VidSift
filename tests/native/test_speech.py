import os
import subprocess
import tempfile
import wave
import unittest
from unittest.mock import patch
from pathlib import Path
from native import host

class SpeechBoundaryTests(unittest.TestCase):
    def test_no_speech_skips_groq_and_detector_failure_is_not_silence(self):
        with tempfile.TemporaryDirectory() as directory:
            service=host.Service(Path(directory))
            with patch.object(service,'detect_speech',return_value={'speechStatus':'none','duration':143}),patch.object(host,'groq_upload') as upload:
                result=service.transcribe_groq({},host.Job('none'),lambda _:None)
                self.assertEqual(result['speechStatus'],'none');self.assertEqual(result['srt'],'');upload.assert_not_called()
            with patch.object(service,'detect_speech',side_effect=ValueError('音频解码失败')):
                with self.assertRaisesRegex(ValueError,'解码'):service.transcribe_groq({},host.Job('failed'),lambda _:None)
    def test_shared_detection_cache_rechecks_audio_identity_and_never_uploads_music(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source';source.write_bytes(b'original audio')
            service=host.Service(Path(directory)/'cache');descriptor=service.local_audio.add(source,'123',10,{})
            job=host.Job('detect')
            with patch.object(job,'run',return_value=(json.dumps({'result':{'speechStatus':'none','duration':10}}),'')) as run:
                self.assertEqual(service.detect_speech(descriptor,job,lambda _:None)['speechStatus'],'none')
                self.assertEqual(service.transcribe_groq(descriptor,job,lambda _:None)['uploadedBytes'],0)
                self.assertEqual(run.call_count,1);self.assertIn('--speech-worker',run.call_args.args[0])
                with self.assertRaisesRegex(ValueError,'平台'):service.detect_speech({**descriptor,'platform':'youtube'},job,lambda _:None)
                cached,_=service.local_audio.lookup(descriptor['fingerprint']);cached.write_bytes(b'tampered audio')
                with self.assertRaisesRegex(ValueError,'校验'):service.detect_speech(descriptor,job,lambda _:None)

@unittest.skipUnless(os.environ.get('VIDSIFT_TEST_VAD_MODEL'), 'real VAD model supplied by explicit acceptance lane')
class RealSpeechTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.model=patch.object(host,'speech_model_path',return_value=Path(os.environ['VIDSIFT_TEST_VAD_MODEL']));self.model.start();self.addCleanup(self.model.stop)
    def test_real_speech_and_sparse_speech_keep_the_original_audio(self):
        source=Path(__file__).resolve().parents[2]/'test'/'sample.m4a'
        self.assertTrue(host.has_reliable_speech(source,6.765011))
        sparse=Path(self.directory.name)/'sparse.wav'
        subprocess.run([host.find_ffmpeg(),'-v','error','-i',str(source),'-af','apad=pad_dur=35',str(sparse)],check=True)
        self.assertTrue(host.has_reliable_speech(sparse,41.765011))
    def test_silence_and_decode_failure_are_distinct(self):
        silent=Path(self.directory.name)/'silence.wav'
        with wave.open(str(silent),'wb') as audio:
            audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(16000);audio.writeframes(bytes(16000*2*2))
        self.assertFalse(host.has_reliable_speech(silent,2))
        invalid=Path(self.directory.name)/'invalid.wav';invalid.write_bytes(b'not audio')
        with self.assertRaisesRegex(ValueError,'解码'):host.has_reliable_speech(invalid,2)
