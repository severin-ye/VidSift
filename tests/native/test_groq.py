import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from native import host


class GroqTests(unittest.TestCase):
    def test_transport_uses_requests_without_redirect_or_retry_and_closes_stream(self):
        import requests
        from urllib.request import Request
        response=MagicMock();response.status_code=200;response.raw.read.return_value=b'{}'
        with patch.object(requests,'request',return_value=response) as send:
            with host.groq_open(Request('https://api.groq.com/openai/v1/audio/transcriptions',data=b'audio',headers={'Authorization':'Bearer dummy'}),30) as stream:
                self.assertEqual(stream.read(100),b'{}')
            self.assertFalse(send.call_args.kwargs['allow_redirects']);self.assertTrue(send.call_args.kwargs['stream']);self.assertEqual(send.call_args.kwargs['timeout'],(15,30));response.close.assert_called_once()
        response.status_code=302
        with patch.object(requests,'request',return_value=response):
            with self.assertRaises(ValueError):
                with host.groq_open(Request('https://api.groq.com/openai/v1/audio/transcriptions'),30):pass
    def test_key_exact_env_and_bom_quoted_file(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True), patch.object(Path, 'home', return_value=Path(directory)):
            (Path(directory)/'.env').write_text('\ufeffOTHER_GROQ_API_KEY=no\nGROQ_API_KEY="test-secret"\n', encoding='utf-8')
            self.assertEqual(host.groq_key(), 'test-secret')
            with patch.dict(os.environ, {'GROQ_API_KEY':'env-secret'}):
                self.assertEqual(host.groq_key(), 'env-secret')

    def test_segments_keep_real_times_and_allow_tail_silence(self):
        result = host.groq_result({'duration':100, 'segments':[{'start':1.234,'end':2.5,'text':'你好。'}]},100,'whisper-large-v3')
        self.assertIn('00:00:01,234 --> 00:00:02,500', result['srt'])
        self.assertNotIn('00:01:40',result['srt'])
        for payload in ({'duration':50,'segments':[{'start':0,'end':1,'text':'截断'}]}, {'duration':100,'segments':[]}, {'duration':100,'segments':[{'start':3,'end':2,'text':'反序'}]}):
            with self.assertRaises(ValueError): host.groq_result(payload,100,'whisper-large-v3')

    def test_settings_reject_unknown_model_and_bounds(self):
        self.assertEqual(host.groq_settings({}), ('whisper-large-v3-turbo',180))
        for values in ({'model':'other'},{'timeoutSeconds':29},{'timeoutSeconds':True}):
            with self.assertRaises(ValueError): host.groq_settings(values)

    def test_missing_key_and_http_errors_are_sanitized_without_retry(self):
        from urllib.error import HTTPError
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'audio.mp4';path.write_bytes(b'audio')
            with patch.object(host,'groq_key',return_value=''):
                with self.assertRaisesRegex(ValueError,'GROQ_API_KEY'): host.groq_upload(path,10,'whisper-large-v3',30)
            with patch.object(host,'groq_key',return_value='secret'), patch.object(host,'groq_open',side_effect=HTTPError('https://secret',429,'secret',{},io.BytesIO(b'secret'))) as op:
                with self.assertRaisesRegex(ValueError,'429') as error: host.groq_upload(path,10,'whisper-large-v3',30)
                self.assertNotIn('secret',str(error.exception));self.assertEqual(op.call_count,1)

    def test_source_identity_and_cancel_before_child(self):
        with tempfile.TemporaryDirectory() as directory:
            service=host.Service(Path(directory));source=Path(directory)/'audio';source.write_bytes(b'audio')
            descriptor=service.local_audio.add(source,'123',10,{})
            request={**descriptor,'model':'whisper-large-v3'}
            with self.assertRaisesRegex(ValueError,'编号'): service.transcribe_groq({**request,'videoId':'456'},host.Job('x'),lambda _:None)
            job=host.Job('x');job.cancel()
            with self.assertRaises(host.Cancelled): service.transcribe_groq(request,job,lambda _:None)

    def test_network_errors_never_echo_headers_or_server_body(self):
        from urllib.error import HTTPError
        with tempfile.TemporaryDirectory() as directory, patch.object(host,'groq_key',return_value='secret'):
            path=Path(directory)/'audio.mp4';path.write_bytes(b'audio')
            for failure in (TimeoutError('secret'), ValueError('Authorization secret'), HTTPError('secret',500,'secret',{},io.BytesIO(b'secret'))):
                with patch.object(host,'groq_open',side_effect=failure) as operation:
                    with self.assertRaises(ValueError) as error: host.groq_upload(path,10,'whisper-large-v3',30)
                    self.assertNotIn('secret',str(error.exception));self.assertEqual(operation.call_count,1)

    def test_multipart_contract_and_output_bounds(self):
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory() as directory, patch.object(host,'groq_key',return_value='secret'):
            path=Path(directory)/'audio.mp4';path.write_bytes(b'audio')
            response=MagicMock();response.__enter__.return_value=response
            response.read.return_value=json.dumps({'duration':10,'segments':[{'start':0,'end':2,'text':'真实字幕'}]}).encode()
            with patch.object(host,'groq_open',return_value=response) as operation:
                result=host.groq_upload(path,10,'whisper-large-v3',30)
                request,timeout=operation.call_args.args
                self.assertEqual(request.full_url,'https://api.groq.com/openai/v1/audio/transcriptions');self.assertEqual(timeout,30)
                self.assertIn(b'name="timestamp_granularities[]"\r\n\r\nsegment',request.data)
                self.assertEqual(result['segmentCount'],1)
            response.read.return_value=b'x'*(4*host.MAX_MESSAGE+1)
            with patch.object(host,'groq_open',return_value=response):
                with self.assertRaisesRegex(ValueError,'体积'): host.groq_upload(path,10,'whisper-large-v3',30)
        repeated={'duration':10,'segments':[{'start':i,'end':i+.5,'text':'重复'} for i in range(5)]}
        with self.assertRaisesRegex(ValueError,'重复'): host.groq_result(repeated,10,'whisper-large-v3')

    def test_dispatch_does_not_block_and_cancel_discards_late_result(self):
        import threading
        output=io.BytesIO();started=threading.Event();release=threading.Event()
        with tempfile.TemporaryDirectory() as directory:
            instance=host.Host(io.BytesIO(),output,Path(directory))
            def waiting(request,job,progress):
                started.set();release.wait(3);return {'srt':'late'}
            with patch.object(instance.service,'transcribe_groq',side_effect=waiting):
                instance.dispatch({'id':'work','action':'transcribe_groq'})
                self.assertTrue(started.wait(1))
                instance.dispatch({'id':'cancel','action':'cancel','targetId':'work'})
                release.set()
                for thread in instance.threads: thread.join(3)
            output.seek(0);messages=[]
            while message:=host.read_frame(output):messages.append(message)
            self.assertFalse(any(m['id']=='work' and m['type']=='result' for m in messages))
            self.assertTrue(any(m['id']=='work' and m['type']=='error' for m in messages))

    def test_job_cancels_network_owner_process_promptly(self):
        import sys
        import threading
        import time
        job=host.Job('child');errors=[]
        def run():
            try: job.run([sys.executable,'-c','import time;time.sleep(30)'],timeout=35)
            except host.Cancelled: errors.append('cancelled')
        worker=threading.Thread(target=run);worker.start()
        deadline=time.monotonic()+3
        while job.process is None and time.monotonic()<deadline:time.sleep(.01)
        job.cancel();worker.join(3)
        self.assertFalse(worker.is_alive());self.assertEqual(errors,['cancelled'])

    def test_full_source_runs_only_pinned_child_and_reports_sizes(self):
        with tempfile.TemporaryDirectory() as directory:
            service=host.Service(Path(directory));source=Path(directory)/'audio';source.write_bytes(b'audio')
            descriptor=service.local_audio.add(source,'123',10,{})
            job=host.Job('child')
            reply={'result':host.groq_result({'duration':10,'segments':[{'start':0,'end':2,'text':'原文'}]},10,'whisper-large-v3')}
            with patch.object(job,'run',return_value=(json.dumps(reply),'')) as run:
                result=service.transcribe_groq({**descriptor,'model':'whisper-large-v3'},job,lambda _:None)
                self.assertEqual(result['uploadedBytes'],5);self.assertEqual(result['inputBytes'],5)
                self.assertIn('--groq-worker',run.call_args.args[0]);self.assertNotIn('secret',str(run.call_args))
            entry=service.local_audio.load(descriptor['fingerprint'])
            self.assertEqual(list(entry['leases']),[service.local_audio.connection])
            source_path,_=service.local_audio.lookup(descriptor['fingerprint']);source_path.write_bytes(b'other')
            with self.assertRaisesRegex(ValueError,'校验'): service.transcribe_groq(descriptor,job,lambda _:None)

    def test_oversize_compression_never_truncates_and_refuses_remaining_limit(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(host,'GROQ_UPLOAD_LIMIT',4):
            service=host.Service(Path(directory));source=Path(directory)/'audio';source.write_bytes(b'audio')
            descriptor=service.local_audio.add(source,'123',10,{})
            job=host.Job('child');commands=[]
            def convert(command,timeout):
                commands.append(command);Path(command[-1]).write_bytes(b'still-large');return '', ''
            with patch.object(host,'find_ffmpeg',return_value='ffmpeg'),patch.object(job,'run',side_effect=convert):
                with self.assertRaisesRegex(ValueError,'未截断'):service.transcribe_groq(descriptor,job,lambda _:None)
            self.assertEqual(len(commands),1);self.assertNotIn('-t',commands[0]);self.assertNotIn('-ss',commands[0])
            self.assertFalse(list(service.local_audio.root.glob('*.m4a')))

    def test_long_audio_uses_duration_budget_and_keeps_full_source(self):
        with tempfile.TemporaryDirectory() as directory:
            service=host.Service(Path(directory));source=Path(directory)/'audio'
            with source.open('wb') as f: f.truncate(65_529_638)
            duration=2697.747;descriptor=service.local_audio.add(source,'123',duration,{})
            job=host.Job('child');commands=[]
            reply={'result':host.groq_result({'duration':duration,'segments':[{'start':0,'end':2,'text':'原文'}]},duration,'whisper-large-v3')}
            def run(command,timeout):
                commands.append(command)
                if '--groq-worker' in command:return json.dumps(reply),''
                Path(command[-1]).write_bytes(b'compressed-full-audio')
                return 'out_time_us=2697747000\nprogress=end\n',''
            with patch.object(host,'find_ffmpeg',return_value='ffmpeg'),patch.object(job,'run',side_effect=run):
                result=service.transcribe_groq({**descriptor,'model':'whisper-large-v3'},job,lambda _:None)
            self.assertEqual(commands[0][commands[0].index('-b:a')+1],'48k')
            self.assertNotIn('-t',commands[0]);self.assertNotIn('-ss',commands[0])
            self.assertEqual(result['duration'],duration);self.assertEqual(result['inputBytes'],65_529_638)
            self.assertFalse(list(service.local_audio.root.glob('*.m4a')))

    def test_compression_rejects_incomplete_audio_before_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            service=host.Service(Path(directory));source=Path(directory)/'audio'
            with source.open('wb') as f:f.truncate(25_000_000)
            descriptor=service.local_audio.add(source,'123',60,{})
            job=host.Job('child');commands=[]
            def run(command,timeout):
                commands.append(command)
                if '--groq-worker' in command:return json.dumps({'result':{'srt':'unexpected upload'}}),''
                Path(command[-1]).write_bytes(b'incomplete')
                return 'out_time_us=30000000\nprogress=end\n',''
            with patch.object(host,'find_ffmpeg',return_value='ffmpeg'),patch.object(job,'run',side_effect=run):
                with self.assertRaisesRegex(ValueError,'时长'):service.transcribe_groq(descriptor,job,lambda _:None)
            self.assertEqual(len(commands),1);self.assertFalse(list(service.local_audio.root.glob('*.m4a')))
