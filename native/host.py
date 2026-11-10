"""Length-prefixed Native Messaging host. stdout is exclusively protocol data.

Media workflow adapted from BiliNote (MIT), Copyright (c) 2024 Jeffery Huang;
see THIRD_PARTY.md for original sources and full license. No ASR runs here.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
import html
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen
from urllib.request import HTTPRedirectHandler, build_opener

ORIGIN = 'chrome-extension://kggdkncbamdlhhihfkeldbbkppkgihad/'
MAX_MESSAGE = 1024 * 1024
CHUNK_SIZE = 256 * 1024
ROOT = Path(os.environ.get('LOCALAPPDATA', Path.home() / '.local' / 'share')) / 'VidSift'


def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        block = stream.read(size - len(result))
        if not block:
            if not result:
                return None
            raise EOFError('本地消息不完整')
        result.extend(block)
    return bytes(result)


def read_frame(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack('<I', header)[0]
    if not 0 < size <= MAX_MESSAGE:
        raise ValueError('本地消息超过 1 MiB 限制')
    payload = read_exact(stream, size)
    if payload is None:
        raise EOFError('本地消息不完整')
    message = json.loads(payload.decode('utf-8'))
    if not isinstance(message, dict):
        raise ValueError('本地消息必须是对象')
    return message


def write_frame(stream, message):
    data = json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    if len(data) > MAX_MESSAGE:
        raise ValueError('本地响应超过 1 MiB 限制')
    stream.write(struct.pack('<I', len(data)) + data)
    stream.flush()


def validate_url(url):
    parsed = urlparse(url if isinstance(url, str) else '')
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('仅支持指定平台的 HTTPS 视频链接')
    hostname = (parsed.hostname or '').lower()
    for platform, domains in [('bilibili', ('bilibili.com', 'b23.tv')), ('youtube', ('youtube.com', 'youtu.be')), ('douyin', ('douyin.com',))]:
        if any(hostname == d or hostname.endswith('.' + d) for d in domains):
            return platform
    raise ValueError('不支持此视频平台')


def canonical_media_url(url):
    platform = validate_url(url)
    if platform != 'douyin':
        return url
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    match = re.fullmatch(r'/video/(\d+)/?', parsed.path)
    video_id = match.group(1) if match else (query.get('modal_id') or query.get('aweme_id') or [None])[0]
    if video_id is None:
        return url  # Share links still need their platform redirect.
    if not re.fullmatch(r'\d+', video_id):
        raise ValueError('抖音视频编号无效')
    return 'https://www.douyin.com/video/' + video_id


def validate_douyin_media_url(value):
    try:
        parsed = urlparse(value if isinstance(value, str) else '')
        domains = ('douyinvod.com', 'douyin.com', 'zjcdn.com', 'bytecdn.cn', 'ibytedtos.com', 'byteimg.com', 'pstatp.com')
        hostname = (parsed.hostname or '').lower()
        valid = isinstance(value, str) and len(value) < 8192 and parsed.scheme == 'https' and parsed.username is None and parsed.password is None and parsed.port in (None, 443) and any(hostname == d or hostname.endswith('.' + d) for d in domains)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError('抖音原视频资源地址未通过 HTTPS 和平台 CDN 校验')
    return value


def positive_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def douyin_audio_candidates(resource, duration):
    values = resource.get('audioCandidates', [])
    if not isinstance(values, list) or len(values) > 12:
        raise ValueError('抖音音轨候选数量或格式无效')
    result = []
    for entry in values:
        if not isinstance(entry, dict) or not isinstance(entry.get('urls'), list) or not 1 <= len(entry['urls']) <= 3:
            raise ValueError('抖音音轨备用地址格式无效')
        urls = list(dict.fromkeys(validate_douyin_media_url(u) for u in entry['urls']))
        for key in ('size', 'bitrate'):
            if key in entry and not positive_number(entry[key]):
                raise ValueError('抖音音轨大小或码率无效')
        size, bitrate = entry.get('size'), entry.get('bitrate')
        expected = size or (bitrate * duration / 8 if bitrate else None)
        if expected is not None and not positive_number(expected):
            raise ValueError('抖音音轨预计大小无效')
        result.append({'urls': urls, 'size': size, 'bitrate': bitrate, 'expectedBytes': expected, 'sizeBasis': 'metadata' if size else 'estimate' if bitrate else 'unknown'})
    if not result and resource.get('audioUrl') is not None:
        result = [{'urls': [validate_douyin_media_url(resource['audioUrl'])], 'size': None, 'bitrate': None, 'expectedBytes': None, 'sizeBasis': 'unknown'}]
    return sorted(result, key=lambda v: v['expectedBytes'] if v['expectedBytes'] is not None else math.inf)


def subtitle_body(raw, ext):
    """Normalize bounded platform caption data; never treat arbitrary text as cues."""
    if isinstance(raw, str):
        if len(raw.encode('utf-8')) > 4 * MAX_MESSAGE:
            return []
        if ext in ('json', 'json3'):
            try:
                raw = json.loads(raw)
            except ValueError:
                return []
        else:
            cues = []
            pattern = r'(?m)^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})[ \t]*-->[ \t]*(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})[^\n]*\n([\s\S]*?)(?=\n[ \t]*\n|\Z)'
            for m in re.finditer(pattern, raw.replace('\r\n', '\n')):
                v=m.groups(); start=int(v[0] or 0)*3600+int(v[1])*60+int(v[2])+int(v[3])/1000; end=int(v[4] or 0)*3600+int(v[5])*60+int(v[6])+int(v[7])/1000
                if int(v[1]) < 60 and int(v[2]) < 60 and int(v[5]) < 60 and int(v[6]) < 60:
                    cues.append({'from':start,'to':end,'content':html.unescape(re.sub(r'<[^>]+>', '', v[8])).strip()})
            raw={'body':cues}
    if not isinstance(raw, dict):
        return []
    body=raw.get('body')
    if not isinstance(body, list):
        if isinstance(raw.get('utterances'), list):
            body=[{'from':v.get('start_time', -1)/1000,'to':v.get('end_time', -1)/1000,'content':v.get('text')} for v in raw['utterances'][:10000] if isinstance(v, dict) and isinstance(v.get('start_time'), (int,float)) and isinstance(v.get('end_time'), (int,float))]
        else:
            body=[{'from':e.get('tStartMs',0)/1000,'to':(e.get('tStartMs',0)+e.get('dDurationMs',0))/1000,'content':''.join(v.get('utf8','') for v in e.get('segs',[]) if isinstance(v,dict) and isinstance(v.get('utf8',''),str))} for e in raw.get('events',[])[:10000] if isinstance(e,dict) and isinstance(e.get('tStartMs',0),(int,float)) and isinstance(e.get('dDurationMs',0),(int,float))]
    result=[]
    for cue in body[:10000]:
        if not isinstance(cue,dict): continue
        start,end,text=cue.get('from'),cue.get('to'),cue.get('content')
        if isinstance(start,(int,float)) and not isinstance(start,bool) and math.isfinite(start) and start>=0 and positive_number(end) and end>start and isinstance(text,str) and text.strip():
            result.append({'from':start,'to':end,'content':text.strip()[:8192]})
    return result


def douyin_browser_source(source, url):
    if 'douyin' not in source:
        return None
    resource = source['douyin']
    match = re.fullmatch(r'/video/(\d+)', urlparse(url).path)
    if not isinstance(resource, dict) or source.get('platform') != 'douyin' or not match or str(source.get('videoId')) != match.group(1) or str(resource.get('videoId')) != match.group(1):
        raise ValueError('抖音页面原视频资源的作品编号与当前视频链接不一致')
    title = source.get('title')
    if not isinstance(title, str) or not title.strip():
        raise ValueError('抖音页面原视频资源缺少当前作品标题')
    try:
        duration = float(source.get('duration'))
    except (TypeError, ValueError):
        raise ValueError('抖音页面原视频资源的作品时长无效') from None
    if isinstance(source.get('duration'), bool) or not math.isfinite(duration) or duration <= 0:
        raise ValueError('抖音页面原视频资源的作品时长必须是正有限秒数')
    info = {'id': match.group(1), 'title': title.strip(), 'duration': duration, '_douyin_video_url': validate_douyin_media_url(resource.get('videoUrl'))}
    if resource.get('audioUrl') is not None:
        info['_douyin_audio_url'] = validate_douyin_media_url(resource['audioUrl'])
    candidates = douyin_audio_candidates(resource, duration)
    if candidates:
        info['_douyin_audio_candidates'] = candidates
        info['_douyin_audio_url'] = candidates[0]['urls'][0]
    tracks = resource.get('subtitleTracks', [])
    if not isinstance(tracks, list) or len(tracks) > 12:
        raise ValueError('抖音字幕候选格式无效')
    info['subtitles'] = {}
    for track in tracks:
        if not isinstance(track, dict) or track.get('ext') not in ('srt', 'vtt', 'json', 'json3'):
            raise ValueError('抖音字幕轨道格式无效')
        address = validate_douyin_media_url(track.get('url'))
        language = track.get('language', 'und')
        if not isinstance(language, str) or len(language) > 32:
            raise ValueError('抖音字幕语言格式无效')
        info['subtitles'].setdefault(language, []).append({'url': address, 'ext': track['ext']})
    info['_subtitle_status'] = 'unknown'
    return info


@dataclass
class Settings:
    enabled: bool = False
    mode: str = 'auto'
    interval: float = 5
    maxCollages: int = 15
    rows: int = 3
    columns: int = 3
    width: int = 960
    height: int = 540
    quality: int = 90
    sceneThreshold: float = .3

    @classmethod
    def parse(cls, values):
        if not isinstance(values, dict):
            raise ValueError('截图设置格式错误')
        settings = cls(**{k: v for k, v in values.items() if k in cls.__dataclass_fields__})
        if not isinstance(settings.enabled, bool) or settings.mode not in ('auto', 'interval', 'scene'):
            raise ValueError('截图模式无效')
        limits = {'interval': (.1, 3600), 'maxCollages': (1, 15), 'rows': (1, 3), 'columns': (1, 3), 'width': (160, 3840), 'height': (90, 2160), 'quality': (1, 100), 'sceneThreshold': (0, 1)}
        for key, (low, high) in limits.items():
            value = getattr(settings, key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
                raise ValueError('截图参数无效：' + key)
            if key not in ('interval', 'sceneThreshold') and int(value) != value:
                raise ValueError('截图参数必须是整数：' + key)
            if key not in ('interval', 'sceneThreshold'):
                setattr(settings, key, int(value))
        return settings

    @property
    def cap(self):
        return min(135, self.maxCollages * self.rows * self.columns)


def interval_times(duration, settings):
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('无法获取视频时长')
    interval = max(settings.interval, math.ceil(duration / settings.cap))
    return [i * interval for i in range(min(settings.cap, math.ceil(duration / interval)))], interval


def uniform_cap(values, cap):
    values = sorted(set(values))
    if len(values) <= cap:
        return values
    return [values[round(i * (len(values) - 1) / (cap - 1))] for i in range(cap)] if cap > 1 else [values[len(values) // 2]]


def transcript_body(snippets):
    body = []
    for snippet in snippets:
        get = snippet.get if isinstance(snippet, dict) else lambda k, default=None: getattr(snippet, k, default)
        start, duration, text = float(get('start', 0)), float(get('duration', 0)), str(get('text', '')).strip()
        if text and math.isfinite(start) and math.isfinite(duration) and start >= 0 and duration >= 0:
            body.append({'from': start, 'to': start + duration, 'content': html.unescape(text)})
    return body


def douyin_video(data):
    """Find original-video addresses, never music.play_url (speech is absent there)."""
    if isinstance(data, dict):
        video = data.get('video')
        if isinstance(video, dict):
            for key in ('play_addr', 'download_addr', 'playAddr', 'downloadAddr'):
                address = video.get(key)
                if isinstance(address, str) and address.startswith('https://'):
                    return address, data
                if isinstance(address, dict):
                    urls = address.get('url_list') or address.get('urlList') or []
                    if urls and isinstance(urls[0], str) and urls[0].startswith('https://'):
                        return urls[0], data
        for value in data.values():
            found = douyin_video(value)
            if found:
                return found
    elif isinstance(data, list):
        for value in data:
            found = douyin_video(value)
            if found:
                return found
    return None


class DouyinMediaRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        validate_douyin_media_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


class PlatformRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        try:
            platform = validate_url(newurl)
        except ValueError:
            raise ValueError('抖音短链接已失效或跳转到未支持的地址') from None
        if platform != 'douyin':
            raise ValueError('抖音链接跳转到了其他平台')
        return super().redirect_request(request, fp, code, message, headers, newurl)


class Cancelled(Exception):
    pass


class MetadataFailure(ValueError):
    """A sanitized, platform-specific extraction stage failure."""


class MediaFailure(RuntimeError):
    """Only fixed cause categories cross the native boundary; never raw stderr."""
    def __init__(self, category, exit_code):
        self.category = category
        super().__init__('媒体处理失败：%s（退出码 %s）' % (category, exit_code))


def failure_category(stderr):
    text = stderr.lower()
    for patterns, category in [
        (('http error 412', 'status code 412'), '平台访问限制 HTTP 412'),
        (('http error 403', 'status code 403', 'forbidden'), '平台拒绝访问 HTTP 403'),
        (('http error 404', 'status code 404'), '视频或资源不存在 HTTP 404'),
        (('sign in', 'login required', 'fresh cookies', 'cookies are needed', 'confirm you’re not a bot', "confirm you're not a bot"), '平台要求登录或更新登录信息'),
        (('javascript runtime', 'js runtime', 'n challenge', 'signature solving'), '平台 JavaScript 验证失败'),
        (('timed out', 'timeout'), '网络请求超时'),
        (('unable to resolve', 'getaddrinfo', 'name resolution'), '网络域名解析失败'),
        (('ssl', 'certificate verify'), '网络证书验证失败'),
        (('requested format is not available', 'no video formats'), '平台未提供可下载格式'),
        (('unsupported url',), '不支持此视频链接'),
        (('encoder', 'codec', 'invalid data found', 'error opening input'), 'FFmpeg 编解码或输入处理失败'),
    ]:
        if any(pattern in text for pattern in patterns):
            return category
    return '平台或媒体工具未能完成处理'


GROQ_MODELS = ('whisper-large-v3', 'whisper-large-v3-turbo')
GROQ_UPLOAD_LIMIT = 24_000_000


def groq_key():
    value = os.environ.get('GROQ_API_KEY', '').strip()
    if value: return value
    try:
        for line in (Path.home() / '.env').read_text(encoding='utf-8-sig').splitlines():
            match = re.fullmatch(r'\s*(?:export\s+)?GROQ_API_KEY\s*=\s*(.*?)\s*', line)
            if match:
                value = match[1]
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"): value = value[1:-1]
                else: value = re.split(r'\s+#', value, maxsplit=1)[0].strip()
                return value
    except (OSError, UnicodeError): pass
    return ''


def groq_settings(request):
    model = request.get('model', 'whisper-large-v3-turbo')
    timeout = request.get('timeoutSeconds', 180)
    if model not in GROQ_MODELS: raise ValueError('Groq 转写模型不在允许清单中')
    if not positive_number(timeout) or not 30 <= timeout <= 600: raise ValueError('Groq 超时须在 30–600 秒之间')
    return model, timeout


def groq_result(payload, duration, model):
    if not isinstance(payload, dict) or not positive_number(payload.get('duration')) or abs(payload['duration'] - duration) > max(3, duration * .002):
        raise ValueError('Groq 返回时长与完整音频不符')
    segments = payload.get('segments')
    if not isinstance(segments, list) or not segments or len(segments) > min(20000, duration * 10 + 20): raise ValueError('Groq 字幕分段为空或数量异常')
    def stamp(value):
        ms = round(value * 1000)
        return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}'
    rows, last, previous, repeats, text_size = [], -1, '', 0, 0
    for segment in segments:
        if not isinstance(segment, dict): raise ValueError('Groq 字幕分段格式无效')
        start, end, text = segment.get('start'), segment.get('end'), segment.get('text')
        if not isinstance(start, (int, float)) or isinstance(start, bool) or not math.isfinite(start) or start < 0 or not positive_number(end) or start >= end or end > duration + 3 or start < last:
            raise ValueError('Groq 字幕时间戳无效')
        if not isinstance(text, str) or not text.strip() or '\x00' in text: raise ValueError('Groq 字幕内容无效')
        text = text.strip().replace('\r', '').replace('\n', ' ')
        text_size += len(text)
        if text_size > min(200000, duration * 40 + 1000): raise ValueError('Groq 字幕内容体积异常')
        repeats = repeats + 1 if text == previous else 1
        if repeats >= 5: raise ValueError('Groq 字幕存在异常重复')
        previous, last = text, start
        rows.append(f'{len(rows)+1}\n{stamp(start)} --> {stamp(end)}\n{text}\n')
    result = {'srt':'\n'.join(rows), 'model':model, 'duration':payload['duration'], 'segmentCount':len(rows)}
    if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > MAX_MESSAGE - 4096: raise ValueError('Groq 字幕超过本地消息上限')
    return result


class GroqNoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Groq 请求出现非预期重定向')


@contextmanager
def groq_open(request, timeout):
    import requests
    from urllib.error import HTTPError
    response = requests.request(request.get_method(), request.full_url, data=request.data,
                                headers=dict(request.header_items()), timeout=(min(15, timeout), timeout),
                                allow_redirects=False, stream=True)
    try:
        if 300 <= response.status_code < 400: raise ValueError('Groq 请求出现非预期重定向')
        if response.status_code >= 400: raise HTTPError(request.full_url, response.status_code, 'Groq HTTP error', {}, None)
        response.raw.decode_content = True
        yield response.raw
    finally:
        response.close()


def groq_upload(path, duration, model, timeout):
    from urllib.error import HTTPError
    key = groq_key()
    if not key: raise ValueError('本机未配置 GROQ_API_KEY')
    if any(ord(char) < 33 or ord(char) > 126 for char in key): raise ValueError('本机 GROQ_API_KEY 格式无效')
    size = path.stat().st_size
    if not 0 < size <= GROQ_UPLOAD_LIMIT: raise ValueError('Groq 上传音频超过 24 MB；本次未上传，请缩短音频')
    boundary = 'VidSift' + uuid.uuid4().hex
    fields = {'model': model, 'language':'zh', 'response_format':'verbose_json', 'timestamp_granularities[]':'segment', 'temperature':'0'}
    parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode() for name,value in fields.items()]
    parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp4"\r\nContent-Type: audio/mp4\r\n\r\n'.encode(), path.read_bytes(), f'\r\n--{boundary}--\r\n'.encode()])
    request = Request('https://api.groq.com/openai/v1/audio/transcriptions', data=b''.join(parts), headers={'Authorization':'Bearer '+key, 'Content-Type':'multipart/form-data; boundary='+boundary}, method='POST')
    try:
        with groq_open(request, timeout) as response:
            raw = response.read(4 * MAX_MESSAGE + 1)
    except HTTPError as error:
        raise ValueError(f'Groq HTTP {error.code}，未自动重试') from None
    except Exception:
        raise ValueError('Groq 网络连接失败或超时，未自动重试') from None
    if len(raw) > 4 * MAX_MESSAGE: raise ValueError('Groq 响应体积超过限制')
    try: payload = json.loads(raw)
    except (ValueError, UnicodeError): raise ValueError('Groq 响应不是有效 JSON') from None
    return groq_result(payload, duration, model)


class Job:
    def __init__(self, task_id):
        self.id = task_id
        self.event = threading.Event()
        self.lock = threading.Lock()
        self.process = None

    def check(self):
        if self.event.is_set():
            raise Cancelled('任务已取消')

    def cancel(self):
        self.event.set()
        with self.lock:
            if self.process and self.process.poll() is None:
                self.terminate(self.process)

    @staticmethod
    def terminate(process):
        # yt-dlp may own an FFmpeg merger; terminate the entire process tree.
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process.poll() is None:
            process.kill()

    def run(self, command, timeout=600):
        self.check()
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        with self.lock:
            self.check()
            # Child tools never consume Native Messaging input. On Windows,
            # inheriting that pipe can block child Python startup while the
            # host's main thread is waiting for the next protocol message.
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags, start_new_session=os.name != 'nt')
            self.process = process
        start = time.monotonic()
        try:
            while True:
                try:
                    output, error = process.communicate(timeout=.2)
                    break
                except subprocess.TimeoutExpired:
                    self.check()
                    if time.monotonic() - start > timeout:
                        raise TimeoutError('媒体处理超时')
            self.check()
            if process.returncode:
                # Downloader output can contain cookies or signed media URLs.
                raise MediaFailure(failure_category(error.decode('utf-8', errors='replace')), process.returncode)
            return output.decode('utf-8', errors='replace'), error.decode('utf-8', errors='replace')
        finally:
            if process.poll() is None:
                self.terminate(process)
            process.communicate()
            with self.lock:
                self.process = None


import hashlib
import ctypes


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def local_settings(values):
    defaults = {'maxDuration': 3600, 'maxSourceBytes': 536870912, 'cacheBytes': 1073741824, 'failureTtlHours': 24, 'successTtlHours': 1}
    if values is None: values = {}
    if not isinstance(values, dict): raise ValueError('本地转写设置无效')
    for key in defaults:
        value = values.get(key, defaults[key])
        if not positive_number(value) and not (key == 'successTtlHours' and isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0): raise ValueError('本地转写设置无效：' + key)
        defaults[key] = value
    return defaults


def finalize_pcm_window(path, duration):
    size = path.stat().st_size
    expected = round(duration * 16000) * 4
    if not size or size % 4 or size > expected or expected - size > 6400:
        raise ValueError('PCM 窗口实际覆盖不足或超过上限')
    padding_samples = (expected - size) // 4
    if padding_samples:
        with path.open('ab') as stream: stream.write(b'\0' * (expected - size))
    return expected, padding_samples


def process_alive(pid):
    if pid == os.getpid(): return True
    if os.name == 'nt':
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle: return False
        code = ctypes.c_ulong()
        try: return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally: kernel.CloseHandle(handle)
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False
    except PermissionError: return True


class LocalAudioCache:
    def __init__(self, root, connection):
        self.root = Path(root).resolve() / 'local-audio'
        self.connection = connection
        self.lock = threading.RLock()
        self.window_lock = threading.Lock()

    @contextmanager
    def transaction(self):
        # Separate Native host connections share one cache; lock metadata updates.
        self.root.mkdir(parents=True, exist_ok=True)
        with self.lock, (self.root / '.lock').open('a+b') as stream:
            stream.seek(0); stream.write(b'0'); stream.flush(); stream.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX)
            try: yield
            finally:
                stream.seek(0)
                if os.name == 'nt': msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else: fcntl.flock(stream, fcntl.LOCK_UN)

    def metadata_path(self, fingerprint):
        if not isinstance(fingerprint, str) or not re.fullmatch('[0-9a-f]{64}', fingerprint):
            raise ValueError('音频指纹无效')
        return self.root / (fingerprint + '.json')

    def load(self, fingerprint):
        path = self.metadata_path(fingerprint)
        try: entry = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError): raise ValueError('本地音频缓存不存在或已过期') from None
        if entry.get('fingerprint') != fingerprint: raise ValueError('音频缓存指纹不匹配')
        entry['leases'] = {key: pid for key, pid in entry.get('leases', {}).items() if isinstance(pid, int) and process_alive(pid)}
        return entry

    def save(self, entry):
        path = self.metadata_path(entry['fingerprint'])
        temporary = path.with_suffix('.' + uuid.uuid4().hex + '.tmp')
        try:
            temporary.write_text(json.dumps(entry), encoding='utf-8')
            for attempt in range(4):
                try:
                    temporary.replace(path)
                    break
                except PermissionError:
                    if attempt == 3: raise
                    time.sleep(.05 * (attempt + 1))
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def descriptor(entry):
        return {key: entry[key] for key in ('fingerprint', 'videoId', 'duration', 'sampleRate')}

    def add(self, source, video_id, duration, settings):
        settings = local_settings(settings)
        if not isinstance(video_id, str) or not re.fullmatch(r'\d+', video_id): raise ValueError('本地音频作品编号无效')
        if not positive_number(duration) or duration > settings['maxDuration']: raise ValueError('本地音频超过时长限制')
        size = source.stat().st_size
        if size > settings['maxSourceBytes'] or size > settings['cacheBytes']: raise ValueError('本地音频超过文件或缓存大小限制')
        source_hash = file_hash(source)
        fingerprint = hashlib.sha256((video_id + ':' + source_hash).encode()).hexdigest()
        with self.transaction():
            output = self.root / (fingerprint + '.media')
            self._cleanup(time.time(), max(0, settings['cacheBytes'] - (0 if output.exists() else size)))
            retained = sum(path.stat().st_size for path in self.root.glob('*.media') if path != output)
            if retained + size > settings['cacheBytes']:
                raise ValueError('活动音频租约占满缓存，请稍后重试')
            entry = {'fingerprint': fingerprint, 'videoId': video_id, 'sha256': source_hash, 'duration': duration, 'sampleRate': 16000, 'size': size, 'settings': settings, 'updated': time.time(), 'status': 'failed', 'leases': {}}
            if output.exists():
                if file_hash(output) != source_hash: raise ValueError('本地音频缓存校验失败')
                try: entry['leases'] = self.load(fingerprint)['leases']
                except ValueError: pass
            else:
                partial = output.with_suffix('.' + uuid.uuid4().hex + '.part')
                try: shutil.copyfile(source, partial); partial.replace(output)
                finally: partial.unlink(missing_ok=True)
            entry['leases'][self.connection] = os.getpid()
            self.save(entry)
            self._cleanup(time.time(), settings['cacheBytes'])
            return self.descriptor(entry)

    def claim(self, fingerprint, video_id):
        with self.transaction():
            entry = self.load(fingerprint)
            if entry['videoId'] != video_id: raise ValueError('本地音频作品编号不匹配')
            self._verify(entry)
            ttl = entry['settings']['successTtlHours' if entry['status'] == 'success' else 'failureTtlHours'] * 3600
            if not entry['leases'] and time.time() - entry['updated'] > ttl: raise ValueError('本地音频缓存已过期')
            entry['leases'][self.connection] = os.getpid(); self.save(entry)
            return self.descriptor(entry)

    def _verify(self, entry):
        path = self.root / (entry['fingerprint'] + '.media')
        if not path.is_file() or path.stat().st_size != entry['size'] or file_hash(path) != entry['sha256']:
            raise ValueError('本地音频源文件校验失败')
        return path

    def lookup(self, fingerprint):
        with self.transaction():
            entry = self.load(fingerprint)
            if self.connection not in entry['leases']: raise ValueError('当前连接尚未领取音频租约')
            path = self.root / (fingerprint + '.media')
            if not path.is_file() or path.stat().st_size != entry['size']: raise ValueError('本地音频源文件无效')
            return path, entry

    def pin_window(self, fingerprint):
        with self.transaction():
            entry = self.load(fingerprint)
            if self.connection not in entry['leases']: raise ValueError('当前连接尚未领取音频租约')
            token = self.connection + ':window:' + uuid.uuid4().hex
            entry['leases'][token] = os.getpid(); self.save(entry)
            return token

    def unpin_window(self, fingerprint, token):
        with self.transaction():
            entry = self.load(fingerprint)
            entry['leases'].pop(token, None); self.save(entry)
            self._cleanup(time.time(), entry['settings']['cacheBytes'])

    def finish(self, fingerprint, status):
        if status not in ('success', 'failed', 'cancelled'): raise ValueError('本地转写终态无效')
        with self.transaction():
            entry = self.load(fingerprint)
            if self.connection not in entry['leases']: raise ValueError('当前连接没有音频租约')
            entry['leases'].pop(self.connection); entry['status'] = status; entry['updated'] = time.time()
            self.save(entry); self._cleanup(time.time(), entry['settings']['cacheBytes'])
        return {'finished': True, 'fingerprint': fingerprint, 'status': status}

    def close(self):
        if not self.root.exists(): return
        with self.transaction():
            for path in self.root.glob('*.json'):
                try:
                    entry = self.load(path.stem)
                    if self.connection in entry['leases']:
                        entry['leases'].pop(self.connection); entry['status'] = 'failed'; entry['updated'] = time.time(); self.save(entry)
                except ValueError: pass

    def cleanup(self, now=None, quota=1073741824):
        with self.transaction(): self._cleanup(time.time() if now is None else now, quota)

    def _cleanup(self, now, quota):
        entries = []
        for path in self.root.glob('*.json'):
            try: entries.append(self.load(path.stem))
            except ValueError: continue
        total = sum(entry['size'] for entry in entries)
        for entry in sorted(entries, key=lambda item: item['updated']):
            ttl = entry['settings']['successTtlHours' if entry['status'] == 'success' else 'failureTtlHours'] * 3600
            if not entry['leases'] and (now - entry['updated'] > ttl or total > quota):
                (self.root / (entry['fingerprint'] + '.media')).unlink(missing_ok=True)
                self.metadata_path(entry['fingerprint']).unlink(missing_ok=True)
                total -= entry['size']


def validate_pcm_window(start, duration, total):
    if isinstance(start, bool) or not isinstance(start, (int, float)) or not math.isfinite(start) or start < 0 or start >= total or not positive_number(duration) or duration > 30:
        raise ValueError('PCM 窗口须在音频内且不超过 30 秒')
    return start, min(duration, total - start)


def model_spec(model, revision, file):
    spec = MODELS.get(model) if isinstance(model, str) else None
    if not spec or spec['revision'] != revision or not isinstance(file, str) or file not in spec['files']:
        raise ValueError('模型、固定版本或文件不在允许清单中')
    return ROOT / 'runtime' / 'models' / 'transformers' / model / file, spec['files'][file]


_MODEL_LOCK = threading.Lock()


def ensure_model(model, revision, file, job, progress):
    path, expected = model_spec(model, revision, file)
    with _MODEL_LOCK:
        job.check()
        if path.is_file() and path.stat().st_size == expected['size'] and file_hash(path) == expected['sha256']:
            return path, expected
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(path.suffix + '.' + uuid.uuid4().hex + '.part')
        try:
            url = 'https://huggingface.co/' + model + '/resolve/' + revision + '/' + file
            progress('正在准备本地转写模型：' + model + '/' + file)
            with urlopen(Request(url, headers={'User-Agent': 'VidSift-local-model'}), timeout=25) as response, partial.open('wb') as target:
                if urlparse(response.geturl()).scheme != 'https': raise ValueError('模型下载必须使用 HTTPS')
                size = 0; last = time.monotonic(); started = last
                while block := response.read(CHUNK_SIZE):
                    job.check()
                    if time.monotonic() - started > 600: raise TimeoutError('本地模型下载超时')
                    size += len(block)
                    if size > expected['size']: raise ValueError('模型文件长度超出固定清单')
                    target.write(block)
                    if time.monotonic() - last > .5:
                        progress(f'正在准备模型文件：{size * 100 // expected["size"]}%'); last = time.monotonic()
            job.check()
            if partial.stat().st_size != expected['size'] or file_hash(partial) != expected['sha256']: raise ValueError('模型文件完整性校验失败')
            partial.replace(path)
            return path, expected
        finally: partial.unlink(missing_ok=True)


MODELS = {'Xenova/whisper-base': {'revision': '64da57285918e20ea79ea5c88eed7197933abaa8',
                         'files': {'config.json': {'size': 2248,
                                                   'sha256': 'd1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b'},
                                   'generation_config.json': {'size': 3776,
                                                              'sha256': '3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05'},
                                   'preprocessor_config.json': {'size': 339,
                                                                'sha256': 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'},
                                   'special_tokens_map.json': {'size': 2194,
                                                               'sha256': 'e67ae3a0aaa99abcd9f187138e12db1f65c16a14761c50ef10eef2c174a7a691'},
                                   'tokenizer.json': {'size': 2480466,
                                                      'sha256': '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566'},
                                   'tokenizer_config.json': {'size': 282683,
                                                             'sha256': '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce'},
                                   'onnx/decoder_model_merged_quantized.onnx': {'size': 53707539,
                                                                                'sha256': 'a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861'},
                                   'onnx/encoder_model_quantized.onnx': {'size': 23200850,
                                                                         'sha256': '3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9'}}},
 'Xenova/whisper-small': {'revision': '2d67713f236afa48a18992566e7647f6ca848e13',
                          'files': {'config.json': {'size': 2232,
                                                    'sha256': '5a6429d21d7a3379dd0861b74510f9f7076f32b563bffc9fcb072482d55ab3be'},
                                    'generation_config.json': {'size': 3837,
                                                               'sha256': '0b7407a4e53a677f826e03c75d409e6f830663932bf43dda3b08c5efa2223279'},
                                    'preprocessor_config.json': {'size': 339,
                                                                 'sha256': 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'},
                                    'special_tokens_map.json': {'size': 2194,
                                                                'sha256': 'e67ae3a0aaa99abcd9f187138e12db1f65c16a14761c50ef10eef2c174a7a691'},
                                    'tokenizer.json': {'size': 2480466,
                                                       'sha256': '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566'},
                                    'tokenizer_config.json': {'size': 282683,
                                                              'sha256': '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce'},
                                    'onnx/decoder_model_merged_quantized.onnx': {'size': 156780950,
                                                                                 'sha256': 'fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24'},
                                    'onnx/encoder_model_quantized.onnx': {'size': 92324809,
                                                                          'sha256': '969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06'}}}}

class AssetStore:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.assets = {}
        self.lock = threading.RLock()

    def new_task(self, _task_id):
        path = self.root / uuid.uuid4().hex
        path.mkdir()
        return path

    def safe(self, path):
        resolved = Path(path).resolve()
        if not resolved.is_relative_to(self.root) or resolved == self.root:
            raise ValueError('缓存路径无效')
        return resolved

    def add(self, path, mime):
        path = self.safe(path)
        metadata = {'assetId': uuid.uuid4().hex, 'name': path.name, 'mime': mime, 'size': path.stat().st_size}
        with self.lock:
            self.assets[metadata['assetId']] = (path, metadata)
        return metadata.copy()

    def lookup(self, asset_id):
        with self.lock:
            if not isinstance(asset_id, str) or asset_id not in self.assets:
                raise ValueError('文件不存在或已释放')
            path, metadata = self.assets[asset_id]
            return self.safe(path), metadata.copy()

    def chunks(self, asset_id):
        path, _ = self.lookup(asset_id)
        with path.open('rb') as stream:
            while chunk := stream.read(CHUNK_SIZE):
                yield chunk

    def release(self, ids):
        if not isinstance(ids, list) or len(ids) > 200:
            raise ValueError('待释放文件编号无效')
        with self.lock:
            for asset_id in ids:
                entry = self.assets.pop(asset_id, None) if isinstance(asset_id, str) else None
                if entry:
                    path = self.safe(entry[0])
                    if path.parent == self.root / 'local-audio':
                        continue  # Persistent cache is retained until lease-aware TTL/quota cleanup.
                    path.unlink(missing_ok=True)
                    if path.parent != self.root and not any(path.parent.iterdir()):
                        path.parent.rmdir()

    def cleanup(self, task):
        task = self.safe(task)
        with self.lock:
            self.assets = {key: value for key, value in self.assets.items() if not value[0].is_relative_to(task)}
            if task.exists():
                shutil.rmtree(task)


def find_ffmpeg():
    candidates = [os.environ.get('VIDSIFT_FFMPEG'), str(ROOT / 'runtime' / 'bin' / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')), shutil.which('ffmpeg')]
    return next((str(Path(p).resolve()) for p in candidates if p and Path(p).is_file()), None)


def diagnostics():
    import importlib.metadata
    versions = {}
    for key, package in [('ytDlp', 'yt-dlp'), ('transcriptApi', 'youtube-transcript-api')]:
        try:
            versions[key] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[key] = None
    return {'version': '5.4.0', 'ffmpeg': bool(find_ffmpeg()), **versions}


def normalize_audio_settings(value=None):
    value = value if isinstance(value, dict) else {}
    return {
        'bitrate': value.get('bitrate') if value.get('bitrate') in ('32k', '64k', '96k', '128k') else '64k',
        'channels': value.get('channels') if value.get('channels') in ('mono', 'stereo', 'keep') else 'mono',
        'sourceBitrate': value.get('sourceBitrate') if type(value.get('sourceBitrate')) is int and value.get('sourceBitrate') in (32, 64, 96, 128) else 64,
    }


def audio_format_selector(target, formats=None):
    # Keep full audio tracks, avoid tiny low-quality speech codecs and descriptive
    # tracks, and retain the platform's preferred language when it is known.
    tracks = [f for f in (formats or []) if isinstance(f, dict) and f.get('vcodec') == 'none' and f.get('acodec') not in (None, 'none') and not f.get('has_drm') and not re.search(r'descript|commentary', str(f.get('format_note', '')), re.I)]
    if tracks:
        preferred = max(float(f.get('language_preference') or -1) for f in tracks)
        tracks = [f for f in tracks if float(f.get('language_preference') or -1) == preferred]
        # A known preferred/original language must not be traded for a smaller dub.
        languages = {f.get('language') for f in tracks if f.get('language')}
        if len(languages) > 1:
            tracks = []  # Delegate language choice to yt-dlp's default sorting.
    rated = []
    for track in tracks:
        try:
            rate = float(track.get('abr') or 0)
        except (TypeError, ValueError):
            continue
        if math.isfinite(rate) and rate >= 32 and re.fullmatch(r'[\w.-]+', str(track.get('format_id', ''))):
            rated.append((rate, track))
    if rated:
        below = [(r, f) for r, f in rated if r <= target]
        rate, selected = max(below, key=lambda x: x[0]) if below else min(rated, key=lambda x: x[0])
        note = f'来源音轨 {rate:g} kbps（目标 {target} kbps）'
        if not below:
            note += '；平台已知完整音轨中没有达到目标的更小候选'
        return str(selected['format_id']), note
    # Unknown bitrate must not reintroduce a lower-priority dubbed track that
    # the language filtering above deliberately excluded.
    unknown = [str(f['format_id']) for f in tracks if not f.get('abr') and re.fullmatch(r'[\w.-]+', str(f.get('format_id', '')))]
    if unknown:
        return '/'.join(unknown), '保留优先语言的完整音轨；候选码率未知，无法确认下载量可进一步缩小'
    if formats:
        return 'ba/b', '由平台默认排序保留音轨；无法确认下载量可进一步缩小'
    return f'ba[abr>=32][abr<={target}]/ba/b', '优先匹配来源目标码率；候选码率未知或未提供，无法确认下载量可进一步缩小'


def validate_audio_duration(progress_output, expected):
    values = re.findall(r'^out_time_us=(\d+)$', progress_output, re.M)
    actual = int(values[-1]) / 1_000_000 if values else 0
    if not actual or abs(actual - expected) > 2.0:
        raise ValueError('压缩音轨时长与完整视频不符，已停止上传，请重试或检查来源音轨')
    return actual


class Service:
    def transcribe_groq(self, request, job, progress):
        job.check()
        model, timeout = groq_settings(request)
        fingerprint = request.get('fingerprint')
        cache, pin, temporary = self.local_audio, None, None
        started = time.monotonic()
        try:
            pin = cache.pin_window(fingerprint)
            path, entry = cache.lookup(fingerprint)
            if entry['videoId'] != request.get('videoId'): raise ValueError('Groq 音频作品编号不匹配')
            cache._verify(entry)
            input_bytes = path.stat().st_size
            if input_bytes > GROQ_UPLOAD_LIMIT:
                ffmpeg = find_ffmpeg()
                if not ffmpeg: raise ValueError('Groq 大音频压缩需要 FFmpeg')
                temporary = cache.root / (uuid.uuid4().hex + '.m4a')
                progress('正在压缩完整音频供 Groq 上传')
                job.run([ffmpeg,'-nostdin','-hide_banner','-loglevel','error','-i',str(path),'-map','0:a:0','-vn','-ac','1','-ar','16000','-c:a','aac','-b:a','64k','-y',str(temporary)], timeout=180)
                path = temporary
            uploaded_bytes = path.stat().st_size
            if not 0 < uploaded_bytes <= GROQ_UPLOAD_LIMIT: raise ValueError('Groq 压缩后仍超过 24 MB，未上传且未截断音频；请缩短音频')
            progress('正在向 Groq 上传完整音频并等待转写')
            # Isolated process owns the socket; cancellation kills it promptly.
            # This discards local late results, but cannot promise server cancellation.
            output, _ = job.run([sys.executable, str(Path(__file__).resolve()), '--groq-worker', str(path), str(entry['duration']), model, str(timeout)], timeout=timeout + 15)
            job.check()
            try: reply = json.loads(output)
            except ValueError: raise ValueError('Groq 本地工作进程响应无效') from None
            if reply.get('error'): raise ValueError(reply['error'])
            result = reply['result']
            result.update(elapsedMs=round((time.monotonic()-started)*1000), inputBytes=input_bytes, uploadedBytes=uploaded_bytes)
            return result
        finally:
            if temporary: temporary.unlink(missing_ok=True)
            if pin: cache.unpin_window(fingerprint, pin)

    def __init__(self, root=None):
        self.store = AssetStore(root or ROOT / 'cache')
        self.local_audio = LocalAudioCache(self.store.root, uuid.uuid4().hex)

    def ytdlp(self, url, task, job, args):
        command = [sys.executable, '-m', 'yt_dlp', '--no-playlist', '--no-warnings', '--socket-timeout', '25', '--retries', '1', '--no-progress', '--no-cache-dir']
        if shutil.which('node'):
            command += ['--js-runtimes', 'node']
        if (task / 'cookies.txt').exists():
            command += ['--cookies', str(task / 'cookies.txt')]
        ffmpeg = find_ffmpeg()
        if ffmpeg:
            command += ['--ffmpeg-location', ffmpeg]
        if '--dump-single-json' in args:
            return job.run(command + args + ['--', url], timeout=45)
        return job.run(command + args + ['--', url])

    def extract(self, url, task, job, progress=None):
        progress = progress or (lambda _: None)
        platform = {'youtube': 'YouTube', 'bilibili': 'B 站', 'douyin': '抖音'}[validate_url(url)]
        progress('正在解析%s视频元数据（最多 45 秒）' % platform)
        try:
            output, _ = self.ytdlp(url, task, job, ['--dump-single-json', '--skip-download'])
            return json.loads(output)
        except (RuntimeError, TimeoutError, json.JSONDecodeError) as error:
            reason = '视频元数据解析超过 45 秒' if isinstance(error, TimeoutError) else (error.category if isinstance(error, MediaFailure) else '视频元数据解析失败')
            if validate_url(url) != 'douyin':
                raise MetadataFailure('%s：%s' % (platform, reason)) from None
            # BiliNote's download_video uses aweme_detail.video.download_addr;
            # share-page hydration supplies the same original-video object.
            job.check()
            progress('抖音元数据解析未成功，正在读取作品分享页（网络超时 25 秒）')
            opener = build_opener(PlatformRedirect())
            try:
                with opener.open(Request(url, headers={'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'Referer': 'https://www.douyin.com/'}), timeout=25) as response:
                    page = response.read(8 * MAX_MESSAGE).decode('utf-8')
            except (OSError, ValueError):
                job.check()
                raise MetadataFailure('抖音：%s；作品分享页读取失败或网络请求超过 25 秒，请检查登录状态和网络' % reason) from None
            job.check()
            for raw in re.findall(r'<script[^>]*>(.*?)</script>', page, re.S):
                raw = html.unescape(unquote(raw.strip()))
                raw = re.sub(r'^window\._ROUTER_DATA\s*=\s*', '', raw).rstrip(';')
                try:
                    found = douyin_video(json.loads(raw))
                except (ValueError, TypeError):
                    continue
                if found:
                    address, item = found
                    video = item.get('video') or {}
                    return {'id': item.get('aweme_id') or item.get('awemeId'), 'title': item.get('desc') or item.get('item_title') or 'Douyin video', 'duration': float(video.get('duration') or 0) / 1000, '_douyin_video_url': address}
            raise MetadataFailure('抖音：%s；作品分享页未包含可用原视频，可能需要登录' % reason)

    def youtube_subtitle(self, video_id, job):
        try:
            output, _ = job.run([sys.executable, str(Path(__file__).resolve()), '--transcript', video_id], timeout=90)
            return json.loads(output)
        except (RuntimeError, TimeoutError, json.JSONDecodeError):
            return None

    def subtitle_fallback(self, info, job):
        tracks = {}
        tracks.update(info.get('automatic_captions') or {})
        tracks.update(info.get('subtitles') or {})
        languages = sorted(tracks, key=lambda lang: (not lang.lower().startswith('zh'), lang != 'en', lang))
        attempts = 0
        for lang in languages[:12]:
            for track in sorted(tracks[lang], key=lambda t: t.get('ext') != 'json3')[:12]:
                if track.get('ext') not in ('json3', 'json', 'srt', 'vtt'):
                    continue
                job.check()
                try:
                    if isinstance(track.get('data'), str):
                        raw = track['data']
                    else:
                        attempts += 1
                        if attempts > 6:
                            return None
                        address = track['url']
                        if info.get('_douyin_video_url'):
                            validate_douyin_media_url(address)
                            opener = build_opener(DouyinMediaRedirect())
                            response = opener.open(Request(address, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyin.com/'}), timeout=10)
                        else:
                            response = urlopen(Request(address, headers={'User-Agent': 'Mozilla/5.0'}), timeout=25)
                        with response:
                            if info.get('_douyin_video_url'):
                                validate_douyin_media_url(response.geturl())
                            payload = response.read(4 * MAX_MESSAGE + 1)
                            if len(payload) > 4 * MAX_MESSAGE:
                                continue
                            raw = payload.decode('utf-8-sig')
                    body = subtitle_body(raw, track['ext'])
                    if body:
                        return {'body': body, 'lan': lang}
                except Exception:
                    job.check()
        return None

    def download_douyin_media(self, media_url, task, job, progress=None, audio=False):
        validate_douyin_media_url(media_url)
        output = task / ('original-audio.m4a' if audio else 'video.mp4')
        partial = output.with_suffix(output.suffix + '.part')
        label = '完整音轨' if audio else '原视频'
        started = time.monotonic()
        last_progress = started
        downloaded = 0

        def check():
            job.check()
            if time.monotonic() - started >= 600:
                raise TimeoutError(f'抖音{label}下载超过 600 秒')

        def report(total):
            if progress:
                amount = downloaded / (1024 * 1024)
                detail = f'{amount:.1f} / {total / (1024 * 1024):.1f} MB，{downloaded * 100 // total}%' if total else f'{amount:.1f} MB'
                progress(f'正在下载{label}：' + detail)

        try:
            check()
            opener = build_opener(DouyinMediaRedirect())
            request = Request(media_url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyin.com/'})
            with opener.open(request, timeout=25) as response:
                validate_douyin_media_url(response.geturl())
                content_type = response.headers.get('Content-Type', '').split(';')[0].strip().lower()
                allowed_types = ('video/mp4', 'application/octet-stream', 'binary/octet-stream') + (('audio/mp4', 'audio/x-m4a') if audio else ())
                if content_type not in allowed_types:
                    raise ValueError(f'抖音{label}返回了非 MP4 内容')
                if response.headers.get('Content-Range'):
                    raise ValueError(f'抖音{label}仅返回部分内容')
                length = response.headers.get('Content-Length')
                total = int(length) if length is not None else None
                if total is not None and total > getattr(job, 'max_source_bytes', math.inf):
                    raise ValueError('本地音频超过源文件大小限制')
                if total is not None and total <= 0:
                    raise ValueError(f'抖音{label}长度无效')
                report(total)
                with partial.open('wb') as target:
                    while True:
                        check()
                        block = response.read(CHUNK_SIZE)
                        check()
                        if not block:
                            break
                        if downloaded == 0 and (len(block) < 12 or block[4:8] != b'ftyp'):
                            raise ValueError(f'抖音{label}内容不是有效 MP4，可能返回了网页')
                        if downloaded + len(block) > getattr(job, 'max_source_bytes', math.inf):
                            raise ValueError('本地音频超过源文件大小限制')
                        target.write(block)
                        downloaded += len(block)
                        if total is not None and downloaded > total:
                            raise ValueError(f'抖音{label}长度不匹配')
                        now = time.monotonic()
                        if now - last_progress >= .5:
                            report(total)
                            last_progress = now
                if not downloaded or (total is not None and downloaded != total):
                    raise ValueError(f'抖音{label}下载不完整')
            check()
            partial.replace(output)
            report(total)
            return output
        finally:
            partial.unlink(missing_ok=True)

    def download(self, url, task, job, video=False, progress=None):
        fallback = task / 'douyin-source.json'
        retrying_douyin = False
        if fallback.exists():
            source = json.loads(fallback.read_text(encoding='utf-8'))
            media_url = source['url']
            # URL came from a platform video object, not from the native caller.
            validate_douyin_media_url(media_url)
            audio_url = source.get('audioUrl')
            if audio_url is not None:
                validate_douyin_media_url(audio_url)
            candidates = douyin_audio_candidates(source, float(source.get('duration') or 1))
            if candidates and not video:
                attempts = 0
                for candidate in candidates:
                    for address in candidate['urls']:
                        if attempts >= 3:
                            break
                        attempts += 1
                        try:
                            output = self.download_douyin_media(address, task, job, progress, audio=True)
                            (task / 'audio-choice.json').write_text(json.dumps({'candidateCount': len(candidates), 'selectedSourceBytes': candidate.get('size'), 'selectedSourceBitrate': candidate.get('bitrate'), 'sourceKind': 'independent-audio', 'selectedSizeBasis': candidate.get('sizeBasis')}), encoding='utf-8')
                            return output
                        except Cancelled:
                            raise
                        except Exception:
                            job.check()
                    if attempts >= 3:
                        break
                if progress:
                    progress('完整音轨的本轮备用来源未下载成功，正在改用原视频音轨')
            (task / 'audio-choice.json').write_text(json.dumps({'candidateCount': len(candidates), 'selectedSourceBytes': None, 'selectedSourceBitrate': None, 'sourceKind': 'video'}), encoding='utf-8')
            try:
                return self.download_douyin_media(media_url, task, job, progress)
            except Cancelled:
                raise
            except Exception:
                job.check()
                if progress:
                    progress('原视频直连下载未完成，正在通过抖音作品链接重试一次')
                # Retry only the platform URL; never retry the failed signed CDN
                # URL through yt-dlp's generic extractor.
                url = canonical_media_url(url)
                retrying_douyin = True
        output = task / ('video.%(ext)s' if video else 'source.%(ext)s')
        selection = json.loads((task / 'audio-selection.json').read_text(encoding='utf-8')) if (task / 'audio-selection.json').exists() else {'selector': audio_format_selector(64)[0]}
        args = (['--max-filesize', str(int(job.max_source_bytes))] if hasattr(job, 'max_source_bytes') else []) + ['-f', 'bv*[height<=720]+ba/b[height<=720]/b' if video else selection['selector'], '-o', str(output), '--print', 'after_move:filepath']
        try:
            text, _ = self.ytdlp(url, task, job, args)
        except Cancelled:
            raise
        except Exception as error:
            job.check()
            if not retrying_douyin:
                raise
            category = error.category if isinstance(error, MediaFailure) else ('作品链接下载超时' if isinstance(error, TimeoutError) else '平台或媒体工具未能完成处理')
            raise ValueError('抖音原视频直连下载失败，作品链接回退也未成功：' + category) from None
        candidates = [Path(line) for line in text.splitlines() if line.strip()]
        for path in reversed(candidates):
            path = self.store.safe(path)
            if path.parent == task and path.is_file():
                return path
        if retrying_douyin:
            raise ValueError('抖音原视频直连下载失败，作品链接回退也未成功：下载器未返回媒体文件')
        raise RuntimeError('下载器未返回媒体文件')

    def cookies(self, cookies, task, platform):
        if not isinstance(cookies, list) or len(cookies) > 1000:
            raise ValueError('登录信息格式无效')
        lines = ['# Netscape HTTP Cookie File']
        domains = {'youtube': ('youtube.com', 'google.com'), 'bilibili': ('bilibili.com',), 'douyin': ('douyin.com',)}[platform]
        for cookie in cookies:
            if not isinstance(cookie, dict):
                continue
            domain = str(cookie.get('domain', '')).lower()
            if not any(domain.lstrip('.') == d or domain.lstrip('.').endswith('.' + d) for d in domains):
                continue
            fields = [domain, 'TRUE' if domain.startswith('.') else 'FALSE', str(cookie.get('path', '/')), 'TRUE' if cookie.get('secure') else 'FALSE', str(int(cookie.get('expirationDate') or 0)), str(cookie.get('name', '')), str(cookie.get('value', ''))]
            if any('\n' in field or '\r' in field or '\t' in field for field in fields):
                continue
            lines.append('\t'.join(fields))
        (task / 'cookies.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    def screenshots(self, video, duration, settings, task, job, progress, warnings):
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            raise RuntimeError('未找到 FFmpeg，请运行 VidSift 安装程序')
        times, interval = interval_times(duration, settings)
        mode = 'interval'
        if settings.mode in ('auto', 'scene'):
            try:
                _, output = job.run([ffmpeg, '-nostdin', '-hide_banner', '-i', str(video), '-vf', "select='gt(scene,%s)',showinfo" % settings.sceneThreshold, '-an', '-f', 'null', '-'], timeout=600)
                scenes = [float(value) for value in re.findall(r'pts_time:([\d.]+)', output)]
                scenes = [t for t in scenes if 0 <= t < duration]
                if scenes:
                    times, mode = uniform_cap(scenes, settings.cap), 'scene'
                else:
                    warnings.append('未检测到场景变化，已按时间间隔截图。')
            except (RuntimeError, TimeoutError):
                warnings.append('场景检测失败，已按时间间隔截图。')
        frames = []
        for index, timestamp in enumerate(times):
            job.check()
            progress('正在提取截图 %s/%s' % (index + 1, len(times)))
            path = task / ('frame_%03d.jpg' % index)
            try:
                job.run([ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', str(timestamp), '-i', str(video), '-frames:v', '1', '-vf', 'scale=%s:%s:force_original_aspect_ratio=decrease,pad=%s:%s:(ow-iw)/2:(oh-ih)/2' % (settings.width, settings.height, settings.width, settings.height), '-y', str(path)], timeout=90)
                if path.is_file():
                    frames.append((timestamp, path))
            except (RuntimeError, TimeoutError):
                warnings.append('无法提取 %.2f 秒处的截图。' % timestamp)
        images = self.montages(frames, settings, task, job)
        return images, {'mode': mode, 'interval': interval, 'frameCount': len(frames), 'collageCount': len(images)}

    def montages(self, frames, settings, task, job):
        from PIL import Image, ImageDraw, ImageFont
        images = []
        frames = sorted(frames, key=lambda item: item[0])[:settings.cap]
        size = settings.rows * settings.columns
        font = ImageFont.load_default(size=max(14, settings.width // 25))
        for offset in range(0, len(frames), size):
            job.check()
            group = frames[offset:offset + size]
            rows = math.ceil(len(group) / settings.columns)
            grid = Image.new('RGB', (settings.width * settings.columns, settings.height * rows), '#202020')
            for index, (timestamp, path) in enumerate(group):
                with Image.open(path) as original:
                    image = original.convert('RGB').resize((settings.width, settings.height), Image.Resampling.LANCZOS)
                draw = ImageDraw.Draw(image)
                label = '%02d:%02d:%02d' % (timestamp // 3600, timestamp // 60 % 60, timestamp % 60)
                draw.text((10, 10), label, fill='white', stroke_width=2, stroke_fill='black', font=font)
                grid.paste(image, ((index % settings.columns) * settings.width, (index // settings.columns) * settings.height))
                image.close()
            output = task / ('collage_%02d.jpg' % (len(images) + 1))
            grid.save(output, quality=settings.quality)
            grid.close()
            images.append(self.store.add(output, 'image/jpeg'))
        return images

    def resolve(self, request, job, progress):
        job.check()
        url = canonical_media_url(request.get('url'))
        platform = validate_url(url)
        settings = Settings.parse(request.get('screenshots') or {})
        source = request.get('source') or {}
        local = request.get('localTranscription') is True
        local_config = local_settings(request.get('localSettings')) if local else None
        local_descriptor = None
        if local:
            if platform != 'douyin': raise ValueError('本地转写目前仅用于抖音')
            job.max_source_bytes = local_config['maxSourceBytes']
        task = self.store.new_task(job.id)
        try:
            self.cookies(request.get('cookies') or [], task, platform)
            if platform == 'bilibili' and source.get('bili', {}).get('pageUrl'):
                candidate = source['bili']['pageUrl']
                if validate_url(candidate) != platform:
                    raise ValueError('B 站当前分 P 链接的平台不匹配')
                url = candidate
            force = request.get('forceAudio') is True
            subtitle = None if force else source.get('subtitle')
            if platform == 'douyin' and subtitle:
                body = subtitle_body(subtitle, 'json')
                subtitle = {'body': body, 'lan': subtitle.get('lan', 'und')} if body else None
            info = douyin_browser_source(source, url) if platform == 'douyin' else None
            browser_resource = info is not None
            info = info or {}
            warnings = []
            progress('已核对当前抖音作品，正在使用页面原视频资源' if browser_resource else '正在读取视频信息和字幕')
            parsed = urlparse(url)
            youtube_id = source.get('videoId')
            if platform == 'youtube' and not youtube_id:
                youtube_id = (parsed.path.strip('/').split('/')[0] if parsed.hostname == 'youtu.be' else (parse_qs(parsed.query).get('v') or [None])[0])
                if not youtube_id and parsed.path.startswith(('/shorts/', '/embed/', '/live/')):
                    youtube_id = parsed.path.split('/')[2]
            if platform == 'youtube' and not subtitle and not force and youtube_id:
                progress('正在读取 YouTube 字幕（最多 90 秒）')
                subtitle = self.youtube_subtitle(str(youtube_id), job)
            # Bilibili supplies current-part metadata and subtitles from its page.
            if not browser_resource and (platform == 'douyin' or not source.get('duration') or not source.get('title') or (not subtitle and not force)):
                try:
                    info = self.extract(url, task, job, progress=progress)
                except (RuntimeError, TimeoutError, MetadataFailure):
                    if platform == 'douyin' or (not source.get('duration') and not subtitle):
                        raise
                    warnings.append('暂时无法获取平台信息，已保留页面提供的视频信息。')
            if platform == 'douyin':
                match = re.fullmatch(r'/video/(\d+)', urlparse(url).path)
                if match and str(info.get('id')) != match.group(1):
                    raise ValueError('抖音解析结果的作品编号与当前视频链接不一致')
            video_id = str(source.get('videoId') or info.get('id') or youtube_id or '')
            if info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming'):
                raise ValueError('暂不支持直播或尚未开始的视频，请使用已发布的完整视频')
            try:
                duration = float(source.get('duration') or info.get('duration') or 0)
            except (ValueError, TypeError):
                raise ValueError('视频时长无效') from None
            if not math.isfinite(duration) or duration < 0:
                raise ValueError('视频时长无效')
            if not subtitle and not force:
                if platform == 'youtube' and not youtube_id:
                    subtitle = self.youtube_subtitle(video_id, job)
                if not subtitle:
                    progress('正在检查平台提供的字幕轨道')
                    subtitle = self.subtitle_fallback(info, job)
            if info.get('_douyin_video_url'):
                media_source = {'url': info['_douyin_video_url'], 'duration': duration}
                if info.get('_douyin_audio_candidates'):
                    media_source['audioCandidates'] = info['_douyin_audio_candidates']
                if info.get('_douyin_audio_url'):
                    media_source['audioUrl'] = info['_douyin_audio_url']
                (task / 'douyin-source.json').write_text(json.dumps(media_source), encoding='utf-8')
            result = {'subtitleStatus': 'available' if subtitle else info.get('_subtitle_status', 'unknown'), 'platform': platform, 'videoId': video_id, 'title': str(source.get('title') or info.get('title') or video_id), 'duration': duration, 'subtitle': subtitle, 'audio': None, 'images': [], 'frameInfo': {'mode': 'disabled', 'interval': settings.interval, 'frameCount': 0, 'collageCount': 0}, 'warnings': warnings}
            need_audio = local or force or (request.get('needAudio') is True and not subtitle)
            if local and (duration > local_config['maxDuration'] or not video_id):
                raise ValueError('本地转写作品编号无效或超过时长限制')
            if (settings.enabled or need_audio) and duration <= 0:
                raise ValueError('无法确认视频时长，已停止下载；暂不支持直播或时长未知的视频')
            audio_settings = normalize_audio_settings(request.get('audioSettings'))
            selector, selection_note = audio_format_selector(audio_settings['sourceBitrate'], info.get('formats'))
            if platform == 'douyin':
                selection_note = '按平台完整口播候选的大小选择来源；缺少实际大小时按码率估算' if info.get('_douyin_audio_url') else '未取得可用独立完整音轨，下载原视频提取口播；其它来源是否存在未知'
            if settings.enabled:
                selection_note = '图片提取需要下载原视频；音频压缩只减少上传体积'
            (task / 'audio-selection.json').write_text(json.dumps({'selector': selector}), encoding='utf-8')
            video = None
            if settings.enabled or need_audio:
                if not find_ffmpeg():
                    raise RuntimeError('未找到 FFmpeg，请运行 VidSift 安装程序')
                progress('正在下载原视频' if settings.enabled else '正在下载完整音轨' if platform == 'douyin' and info.get('_douyin_audio_url') else '正在下载音频')
                video = self.download(url, task, job, video=settings.enabled, progress=progress)
            if need_audio and local:
                if video.stat().st_size > local_config['maxSourceBytes']:
                    raise ValueError('本地音频超过源文件大小限制')
                progress('正在核验本地原始音轨，不重新压缩音频')
                _, probe = job.run([find_ffmpeg(), '-nostdin', '-hide_banner', '-i', str(video), '-map', '0:a:0', '-t', '0', '-f', 'null', '-'], timeout=30)
                match = re.search(r'Duration: (\d+):(\d+):(\d+(?:\.\d+)?)', probe)
                if not match: raise ValueError('无法核验本地音频实际时长')
                actual_duration = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
                if abs(actual_duration - duration) > max(2, duration * .01):
                    raise ValueError('本地原始音轨时长与当前作品不一致')
                local_descriptor = self.local_audio.add(video, video_id, actual_duration, local_config)
                job.check()
                cached, _ = self.local_audio.lookup(local_descriptor['fingerprint'])
                result['localAudio'] = local_descriptor
                result['audio'] = self.store.add(cached, 'audio/mp4')
                choice = json.loads((task / 'audio-choice.json').read_text(encoding='utf-8')) if (task / 'audio-choice.json').exists() else {}
                result['audioInfo'] = {**choice, 'originalBytes': video.stat().st_size, 'outputBytes': cached.stat().st_size, 'duration': actual_duration, 'settings': audio_settings, 'sourceSelection': selection_note, 'localTranscription': True, 'transcoded': False}
            if need_audio and not local:
                progress('正在整理包含人声的完整音轨')
                output = task / 'audio.m4a'
                original_bytes = video.stat().st_size
                progress(f'原始下载 {original_bytes / 1048576:.2f} MB；{selection_note}；正在压缩上传音频')
                command = [find_ffmpeg(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', str(video), '-vn', '-codec:a', 'aac', '-b:a', audio_settings['bitrate']]
                if audio_settings['channels'] != 'keep':
                    command += ['-ac', '1' if audio_settings['channels'] == 'mono' else '2']
                command += ['-progress', 'pipe:1', '-movflags', '+faststart', '-y', str(output)]
                conversion, _ = job.run(command)
                actual_duration = validate_audio_duration(conversion, duration)
                result['audio'] = self.store.add(output, 'audio/mp4')
                choice = json.loads((task / 'audio-choice.json').read_text(encoding='utf-8')) if (task / 'audio-choice.json').exists() else {}
                result['audioInfo'] = {**choice, 'originalBytes': original_bytes, 'outputBytes': output.stat().st_size, 'duration': actual_duration, 'settings': audio_settings, 'sourceSelection': selection_note}
                progress(f'原始下载 {original_bytes / 1048576:.2f} MB → 上传音频 {output.stat().st_size / 1048576:.2f} MB；{selection_note}')
            if settings.enabled:
                result['images'], result['frameInfo'] = self.screenshots(video, duration, settings, task, job, progress, warnings)
            job.check()
            # Keep only assets; remove cookies, raw media and extracted frames.
            keep = {entry[0] for entry in self.store.assets.values()}
            for path in task.iterdir():
                if path not in keep and path.is_file():
                    path.unlink()
            if not any(task.iterdir()):
                task.rmdir()
            return result
        except BaseException:
            if local_descriptor:
                self.local_audio.finish(local_descriptor['fingerprint'], 'cancelled' if job.event.is_set() else 'failed')
            self.store.cleanup(task)
            raise


def fetch_youtube_transcript(video_id):
    from youtube_transcript_api import YouTubeTranscriptApi
    tracks = list(YouTubeTranscriptApi().list(video_id))
    tracks.sort(key=lambda t: (not t.language_code.lower().startswith('zh'), t.is_generated, t.language_code != 'en'))
    for track in tracks:
        try:
            body = transcript_body(track.fetch())
            if body:
                return {'body': body, 'lan': track.language_code}
        except Exception:
            continue
    return None


class Host:
    def __init__(self, input_stream, output_stream, root=None):
        self.input, self.output = input_stream, output_stream
        self.service = Service(root)
        self.lock = threading.Lock()
        self.jobs = {}
        self.threads = []
        self.verified_models = {}

    def emit(self, message):
        with self.lock:
            write_frame(self.output, message)

    def worker(self, request, job):
        result = None
        try:
            job.check()
            progress = lambda text: self.emit({'id': job.id, 'type': 'progress', 'text': text})
            action = request.get('action')
            if action == 'resolve':
                result = self.service.resolve(request, job, progress)
            elif action == 'transcribe_groq':
                result = self.service.transcribe_groq(request, job, progress)
            elif action == 'prepare_local_audio':
                result = self.service.local_audio.claim(request.get('fingerprint'), request.get('videoId'))
                job.check()
            elif action == 'local_audio_finish':
                result = self.service.local_audio.finish(request.get('fingerprint'), request.get('status'))
            elif action == 'read_pcm_window':
                result = self.pcm_window(request, job)
            elif action == 'model_file_info':
                _, result = ensure_model(request.get('model'), request.get('revision'), request.get('file'), job, progress)
            elif action == 'model_file_chunk':
                path, expected = model_spec(request.get('model'), request.get('revision'), request.get('file'))
                offset, length = request.get('offset'), request.get('length')
                if type(offset) is not int or type(length) is not int or not 0 <= offset < expected['size'] or not 0 < length <= CHUNK_SIZE or offset + length > expected['size']:
                    raise ValueError('模型文件读取范围无效')
                # Info must verify the entire pinned file before chunk streaming.
                signature = (path.stat().st_mtime_ns, path.stat().st_size) if path.is_file() else None
                if self.verified_models.get(str(path)) != signature or signature is None:
                    raise ValueError('请先核验模型文件信息')
                with path.open('rb') as stream:
                    stream.seek(offset); block = stream.read(length)
                if len(block) != length: raise ValueError('模型文件分片不完整')
                result = {'base64': base64.b64encode(block).decode('ascii'), 'size': len(block), 'totalSize': expected['size'], 'offset': offset}
            if action == 'model_file_info':
                path, _ = model_spec(request.get('model'), request.get('revision'), request.get('file'))
                self.verified_models[str(path)] = (path.stat().st_mtime_ns, path.stat().st_size)
            job.check()
            self.emit({'id': job.id, 'type': 'result', 'result': result})
        except Exception as error:
            if result and request.get('action') == 'prepare_local_audio':
                self.service.local_audio.finish(result['fingerprint'], 'cancelled' if job.event.is_set() else 'failed')
            if result and request.get('action') == 'resolve':
                if result.get('localAudio'):
                    self.service.local_audio.finish(result['localAudio']['fingerprint'], 'cancelled' if job.event.is_set() else 'failed')
                assets = result.get('images', []) + ([result['audio']] if result.get('audio') else [])
                self.service.store.release([asset['assetId'] for asset in assets])
            safe = str(error) if isinstance(error, (ValueError, Cancelled, TimeoutError, MediaFailure)) else '媒体处理失败，请检查登录状态、网络、平台支持情况和 FFmpeg 安装。'
            self.emit({'id': job.id, 'type': 'error', 'error': safe})
        finally:
            with self.lock:
                self.jobs.pop(job.id, None)

    def pcm_window(self, request, job):
        cache = self.service.local_audio
        if not cache.window_lock.acquire(blocking=False):
            raise ValueError('已有 PCM 窗口正在读取，请串行读取')
        temporary = None
        pin = None
        try:
            pin = cache.pin_window(request.get('fingerprint'))
            path, entry = cache.lookup(request.get('fingerprint'))
            start, duration = validate_pcm_window(request.get('start'), request.get('duration'), entry['duration'])
            ffmpeg = find_ffmpeg()
            if not ffmpeg: raise ValueError('未找到 FFmpeg')
            temporary = cache.root / (uuid.uuid4().hex + '.pcm')
            job.run([ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', str(start), '-i', str(path), '-t', str(duration), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_f32le', '-f', 'f32le', '-y', str(temporary)], timeout=90)
            # Resampling/codec rounding may omit a few samples. Explicitly pad
            # at most the previously accepted 100 ms; larger truncation fails.
            size, padding_samples = finalize_pcm_window(temporary, duration)
            with temporary.open('rb') as stream:
                sequence = 0
                while block := stream.read(CHUNK_SIZE):
                    job.check()
                    self.emit({'id': job.id, 'type': 'chunk', 'sequence': sequence, 'data': base64.b64encode(block).decode('ascii')})
                    sequence += 1
            return {'fingerprint': entry['fingerprint'], 'start': start, 'duration': size / 64000, 'sampleRate': 16000, 'samples': size // 4, 'paddingSamples': padding_samples, 'size': size, 'encoding': 'f32le'}
        finally:
            if temporary: temporary.unlink(missing_ok=True)
            try:
                if pin: cache.unpin_window(request.get('fingerprint'), pin)
            finally:
                cache.window_lock.release()

    def dispatch(self, request):
        task_id = request.get('id')
        if not isinstance(task_id, (str, int)) or isinstance(task_id, bool):
            raise ValueError('缺少请求编号')
        action = request.get('action')
        if action in ('diagnostics', 'ping'):
            self.emit({'id': task_id, 'type': 'result', 'result': diagnostics()})
        elif action == 'groq_status':
            self.emit({'id': task_id, 'type': 'result', 'result': {'configured':bool(groq_key())}})
        elif action in ('resolve', 'prepare_local_audio', 'local_audio_finish', 'read_pcm_window', 'model_file_info', 'model_file_chunk', 'transcribe_groq'):
            with self.lock:
                if task_id in self.jobs or len(self.jobs) >= 2:
                    raise ValueError('任务编号已在使用，或本地任务数量已达上限')
                job = Job(task_id)
                self.jobs[task_id] = job
            thread = threading.Thread(target=self.worker, args=(request, job), daemon=True)
            self.threads.append(thread)
            thread.start()
        elif action == 'cancel':
            with self.lock:
                job = self.jobs.get(request.get('targetId'))
            if job:
                job.cancel()
            self.emit({'id': task_id, 'type': 'result', 'result': {'cancelled': bool(job)}})
        elif action == 'read_asset':
            asset_id = request.get('assetId')
            _, metadata = self.service.store.lookup(asset_id)
            for sequence, chunk in enumerate(self.service.store.chunks(asset_id)):
                self.emit({'id': task_id, 'type': 'chunk', 'sequence': sequence, 'data': base64.b64encode(chunk).decode('ascii')})
            self.emit({'id': task_id, 'type': 'result', 'result': metadata})
        elif action == 'release':
            self.service.store.release(request.get('assetIds'))
            self.emit({'id': task_id, 'type': 'result', 'result': {'released': True}})
        else:
            raise ValueError('不支持此本地操作')

    def run(self):
        try:
            while True:
                request = read_frame(self.input)
                if request is None:
                    break
                try:
                    self.dispatch(request)
                except Exception as error:
                    self.emit({'id': request.get('id'), 'type': 'error', 'error': str(error) if isinstance(error, ValueError) else '本地请求失败'})
        finally:
            with self.lock:
                jobs = list(self.jobs.values())
            for job in jobs:
                job.cancel()
            for thread in self.threads:
                thread.join(timeout=30)
            self.service.local_audio.close()
            for task in list(self.service.store.root.iterdir()):
                if task == self.service.local_audio.root: continue
                # Only task directories created in this process are eligible.
                if any(path.is_relative_to(task) for path, _ in self.service.store.assets.values()):
                    self.service.store.cleanup(task)


def main():
    args = sys.argv[1:]
    if args and args[0] == '--groq-worker':
        try:
            if len(args) != 5: raise ValueError('Groq 工作参数无效')
            model, timeout = groq_settings({'model':args[3], 'timeoutSeconds':float(args[4])})
            result = groq_upload(Path(args[1]), float(args[2]), model, timeout)
            reply = {'result':result}
        except ValueError as error:
            reply = {'error':str(error)}
        except Exception:
            reply = {'error':'Groq 本地工作进程失败'}
        # UTF-8 protocol independent of Windows console's legacy code page.
        sys.stdout.buffer.write(json.dumps(reply, ensure_ascii=False).encode('utf-8'))
        return 0
    if args[:1] == ['--transcript'] and len(args) == 2:
        # Private subprocess mode accepts only a YouTube ID, never a URL or path.
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', args[1]):
            return 2
        print(json.dumps(fetch_youtube_transcript(args[1]), ensure_ascii=False))
        return 0
    if args == ['--diagnostics']:
        import importlib.metadata
        print(json.dumps({'ffmpeg': find_ffmpeg(), 'python': sys.version.split()[0], 'dependencies': {p: importlib.metadata.version(p) for p in ('yt-dlp', 'youtube-transcript-api', 'Pillow')}}))
        return 0
    if args != ['--self-test'] and (not args or args[0] != ORIGIN):
        sys.stderr.write('VidSift：本地消息来源未获信任\n')
        return 2
    if os.name == 'nt':
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    Host(sys.stdin.buffer, sys.stdout.buffer).run()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
