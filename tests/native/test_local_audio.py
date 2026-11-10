import io
import tempfile
import unittest
from pathlib import Path
from native import host

class LocalAudioTests(unittest.TestCase):
    def test_pcm_rounding_padding_is_bounded_and_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'window.pcm';path.write_bytes(b'\0'*(15960*4))
            size,padded=host.finalize_pcm_window(path,1)
            self.assertEqual((size,padded),(16000*4,40))
            path.write_bytes(b'\0'*(8000*4))
            with self.assertRaises(ValueError):host.finalize_pcm_window(path,1)
    def test_zero_success_ttl_is_valid_but_negative_ttl_is_rejected(self):
        self.assertEqual(host.local_settings({'successTtlHours': 0})['successTtlHours'], 0)
        with self.assertRaises(ValueError): host.local_settings({'successTtlHours': -1})
    def test_cache_identity_hash_reclaim_and_release(self):
        with tempfile.TemporaryDirectory() as directory:
            store = host.LocalAudioCache(Path(directory), 'connection-a')
            source = Path(directory) / 'source.m4a'; source.write_bytes(b'original')
            descriptor = store.add(source, '123', 10, {})
            reopened = host.LocalAudioCache(Path(directory), 'connection-b')
            with self.assertRaises(ValueError): reopened.lookup(descriptor['fingerprint'])
            with self.assertRaises(ValueError): reopened.claim(descriptor['fingerprint'], '456')
            reopened.claim(descriptor['fingerprint'], '123')
            path, _ = reopened.lookup(descriptor['fingerprint'])
            path.write_bytes(b'tampered')
            with self.assertRaises(ValueError): reopened.claim(descriptor['fingerprint'], '123')

    def test_window_validation(self):
        for start, duration in [(-1, 1), (0, 31), (float('nan'), 1), (0, 0), (True, 1)]:
            with self.assertRaises(ValueError): host.validate_pcm_window(start, duration, 100)
        self.assertEqual(host.validate_pcm_window(9, 30, 10), (9, 1))

    def test_model_path_revision_and_chunk_bounds(self):
        with self.assertRaises(ValueError): host.model_spec('Xenova/whisper-base', 'main', 'config.json')
        with self.assertRaises(ValueError): host.model_spec('Xenova/whisper-base', host.MODELS['Xenova/whisper-base']['revision'], '../config.json')

    def test_active_cache_survives_expiry_then_finish_expires(self):
        with tempfile.TemporaryDirectory() as directory:
            store = host.LocalAudioCache(Path(directory), 'one')
            source = Path(directory) / 'source'; source.write_bytes(b'abc')
            descriptor = store.add(source, '1', 10, {'successTtlHours': .000001})
            store.cleanup(now=10**12)
            self.assertTrue(store.lookup(descriptor['fingerprint'])[0].exists())
            store.finish(descriptor['fingerprint'], 'success')
            store.cleanup(now=10**12)
            with self.assertRaises(ValueError): store.claim(descriptor['fingerprint'], '1')



class LocalAudioIntegrationTests(unittest.TestCase):
    def make_audio(self, directory):
        import subprocess
        ffmpeg = host.find_ffmpeg()
        if not ffmpeg: self.skipTest('FFmpeg unavailable')
        path = Path(directory) / 'source.wav'
        subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.25', '-y', str(path)], check=True, capture_output=True)
        return path

    def test_real_ffmpeg_windows_tail_and_reconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_root = Path(directory) / 'cache'
            first = host.Host(io.BytesIO(), io.BytesIO(), cache_root)
            source = self.make_audio(directory)
            descriptor = first.service.local_audio.add(source, '123', 2.25, {})
            first.service.local_audio.close()
            second = host.Host(io.BytesIO(), io.BytesIO(), cache_root)
            second.service.local_audio.claim(descriptor['fingerprint'], '123')
            metadata = second.pcm_window({'fingerprint':descriptor['fingerprint'], 'start':1.5,'duration':30}, host.Job('window'))
            self.assertEqual(metadata['samples'], 12000)
            self.assertEqual(metadata['size'], 48000)
            second.output.seek(0)
            chunk = host.read_frame(second.output)
            import base64, struct
            pcm = base64.b64decode(chunk['data'])
            self.assertEqual(len(pcm), 48000)
            self.assertGreater(max(struct.unpack('<12000f',pcm)), .05)
            self.assertEqual(second.pcm_window({'fingerprint':descriptor['fingerprint'],'start':0,'duration':1}, host.Job('window2'))['samples'], 16000)
            second.service.local_audio.finish(descriptor['fingerprint'], 'success')
            with self.assertRaises(ValueError): second.pcm_window({'fingerprint':descriptor['fingerprint'],'start':0,'duration':1}, host.Job('no-lease'))

    def test_cancelled_window_emits_no_chunks_and_deletes_temporary_pcm(self):
        with tempfile.TemporaryDirectory() as directory:
            connection = host.Host(io.BytesIO(), io.BytesIO(), Path(directory) / 'cache')
            descriptor = connection.service.local_audio.add(self.make_audio(directory), '123', 2.25, {})
            job = host.Job('cancelled'); job.cancel()
            with self.assertRaises(host.Cancelled): connection.pcm_window({'fingerprint':descriptor['fingerprint'],'start':0,'duration':1}, job)
            self.assertEqual(connection.output.getvalue(), b'')
            self.assertEqual(list(connection.service.local_audio.root.glob('*.pcm')), [])

    def test_release_does_not_delete_persistent_original_and_quota_protects_active(self):
        with tempfile.TemporaryDirectory() as directory:
            connection = host.Host(io.BytesIO(), io.BytesIO(), Path(directory) / 'cache')
            source = Path(directory) / 'source'; source.write_bytes(b'original')
            descriptor = connection.service.local_audio.add(source,'123',10,{'cacheBytes':8})
            path,_ = connection.service.local_audio.lookup(descriptor['fingerprint'])
            asset = connection.service.store.add(path,'audio/mp4')
            connection.service.store.release([asset['assetId']])
            self.assertTrue(path.exists())
            with self.assertRaises(ValueError): connection.service.local_audio.add(source,'456',10,{'cacheBytes':8})
            self.assertTrue(path.exists())

    def test_real_model_info_and_chunk_pinned_shared_asset(self):
        model='Xenova/whisper-base'; revision=host.MODELS[model]['revision']
        if not host.model_spec(model,revision,'config.json')[0].is_file(): self.skipTest('Shared pinned model unavailable')
        with tempfile.TemporaryDirectory() as directory:
            connection = host.Host(io.BytesIO(),io.BytesIO(),directory)
            connection.worker({'action':'model_file_info','model':model,'revision':revision,'file':'config.json'},host.Job('info'))
            connection.output.seek(0); info=host.read_frame(connection.output)
            self.assertEqual(info['type'],'result')
            self.assertEqual(info['result']['size'],2248)
            connection.output = io.BytesIO()
            connection.worker({'action':'model_file_chunk','model':model,'revision':revision,'file':'config.json','offset':0,'length':10},host.Job('chunk'))
            connection.output.seek(0); result=host.read_frame(connection.output)
            self.assertEqual(result['result']['size'],10)
            connection.output = io.BytesIO()
            connection.worker({'action':'model_file_chunk','model':model,'revision':revision,'file':'config.json','offset':2247,'length':2},host.Job('bad'))
            connection.output.seek(0); self.assertEqual(host.read_frame(connection.output)['type'],'error')

    def test_resolve_local_keeps_original_without_aac_conversion(self):
        import shutil
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            source_path = self.make_audio(directory)
            service = host.Service(Path(directory) / 'cache')
            source={'platform':'douyin','videoId':'123','title':'current','duration':2.25,'douyin':{'videoId':'123','videoUrl':'https://v.douyinvod.com/original.mp4'}}
            def download(url,task,job,**kwargs):
                output=task/'original.wav';shutil.copyfile(source_path,output);return output
            with patch.object(service,'download',side_effect=download),patch.object(service,'extract') as extract:
                result=service.resolve({'url':'https://www.douyin.com/video/123','source':source,'localTranscription':True},host.Job('local'),lambda text:None)
            extract.assert_not_called()
            self.assertFalse(result['audioInfo']['transcoded'])
            self.assertEqual(result['localAudio']['sampleRate'],16000)
            audio_path,_=service.store.lookup(result['audio']['assetId'])
            self.assertEqual(host.file_hash(audio_path),host.file_hash(source_path))
            service.store.release([result['audio']['assetId']])
            self.assertTrue(audio_path.exists())
            service.local_audio.finish(result['localAudio']['fingerprint'],'success')

    def test_model_missing_download_validates_hash_before_atomic_publish(self):
        from unittest.mock import patch
        import hashlib
        model='Xenova/whisper-base';revision=host.MODELS[model]['revision'];payload=b'fixed-content'
        with tempfile.TemporaryDirectory() as directory:
            spec={'revision':revision,'files':{'config.json':{'size':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}}}
            class Response(io.BytesIO):
                def geturl(self):return 'https://huggingface.co/fixed'
            with patch.object(host,'ROOT',Path(directory)),patch.dict(host.MODELS,{model:spec}),patch.object(host,'urlopen',return_value=Response(payload)) as download:
                path,info=host.ensure_model(model,revision,'config.json',host.Job('download'),lambda text:None)
                self.assertEqual(path.read_bytes(),payload)
                self.assertIn('/resolve/'+revision+'/',download.call_args.args[0].full_url)
                path.unlink()
            with patch.object(host,'ROOT',Path(directory)),patch.dict(host.MODELS,{model:spec}),patch.object(host,'urlopen',return_value=Response(b'wrong-content')):
                with self.assertRaises(ValueError):host.ensure_model(model,revision,'config.json',host.Job('bad'),lambda text:None)
                self.assertFalse(path.exists())
                self.assertEqual(list(path.parent.glob('*.part')),[])

    def test_pcm_dispatch_remains_cancellable_and_protocol_loop_does_not_wait(self):
        import threading,time
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            connection=host.Host(io.BytesIO(),io.BytesIO(),directory)
            entered=threading.Event()
            def decode(request,job):
                entered.set()
                while not job.event.wait(.01):pass
                job.check()
            with patch.object(connection,'pcm_window',side_effect=decode):
                connection.dispatch({'id':'window','action':'read_pcm_window'})
                self.assertTrue(entered.wait(1))
                connection.dispatch({'id':'cancel','action':'cancel','targetId':'window'})
                connection.threads[0].join(2)
                self.assertFalse(connection.threads[0].is_alive())
            connection.output.seek(0)
            messages=[]
            while (message:=host.read_frame(connection.output)) is not None:messages.append(message)
            self.assertTrue(any(message['id']=='cancel' and message['result']['cancelled'] for message in messages if message['type']=='result'))
            self.assertTrue(any(message['id']=='window' and message['type']=='error' for message in messages))



    def test_finished_connection_does_not_evict_inflight_window_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            cache=host.LocalAudioCache(Path(directory),'connection')
            source=Path(directory)/'source';source.write_bytes(b'original')
            descriptor=cache.add(source,'123',10,{})
            token=cache.pin_window(descriptor['fingerprint'])
            cache.finish(descriptor['fingerprint'],'cancelled')
            cache.cleanup(now=10**12,quota=0)
            self.assertTrue((cache.root/(descriptor['fingerprint']+'.media')).exists())
            cache.unpin_window(descriptor['fingerprint'],token)
            cache.cleanup(now=10**12,quota=0)
            self.assertFalse((cache.root/(descriptor['fingerprint']+'.media')).exists())

if __name__ == '__main__': unittest.main()
