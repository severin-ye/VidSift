import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VENV_PYTHON = os.path.join(BASE_DIR, "Scripts", "pythonw.exe")

# 若脚本放在 virtualenv 根目录，自动使用该环境；否则使用启动脚本的解释器
if os.path.isfile(VENV_PYTHON) and os.path.abspath(sys.executable).lower() != os.path.abspath(VENV_PYTHON).lower():
    os.execv(VENV_PYTHON, [VENV_PYTHON, __file__, *sys.argv[1:]])

# ----------

from flask import Flask, request, jsonify, Response
from faster_whisper import WhisperModel
import os
import sys
import tempfile
import requests
from datetime import timedelta, datetime
import json
import threading
import time
import logging
import pystray
from PIL import Image
import signal
import subprocess
from logging.handlers import RotatingFileHandler

# 配置日志：同时输出到 stderr（若可用）与本目录 whisper_server.log（.pyw 无控制台时唯一可见的错误来源）
_log_formatter = logging.Formatter(
    '%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
_log_file = os.path.join(BASE_DIR, 'whisper_server.log')
_file_handler = RotatingFileHandler(_log_file, maxBytes=5 * 1024 * 1024, backupCount=3, encoding='utf-8')
_file_handler.setFormatter(_log_formatter)

_root_logger = logging.getLogger()
_root_logger.setLevel(logging.INFO)
_root_logger.addHandler(_file_handler)
# stderr 在 pythonw.exe 下为 None，只有在 python.exe 下才附加
if sys.stderr is not None:
    _stream_handler = logging.StreamHandler()
    _stream_handler.setFormatter(_log_formatter)
    _root_logger.addHandler(_stream_handler)

logger = logging.getLogger(__name__)

# pythonw.exe 下 sys.stdout/stderr 为 None，重定向到日志文件避免第三方库 print 崩溃
class _StreamToLogger:
    def __init__(self, level):
        self._level = level
        self._buf = ''
    def write(self, msg):
        if not msg:
            return
        self._buf += msg
        while '\n' in self._buf:
            line, self._buf = self._buf.split('\n', 1)
            if line.strip():
                logger.log(self._level, line)
    def flush(self):
        if self._buf.strip():
            logger.log(self._level, self._buf)
        self._buf = ''

if sys.stdout is None:
    sys.stdout = _StreamToLogger(logging.INFO)
if sys.stderr is None:
    sys.stderr = _StreamToLogger(logging.ERROR)

# 未捕获异常写入日志
def _excepthook(exc_type, exc_value, exc_tb):
    logger.error("未捕获异常", exc_info=(exc_type, exc_value, exc_tb))
sys.excepthook = _excepthook

app = Flask(__name__)
# 禁用 Flask 默认的请求日志（太啰嗦）
log = logging.getLogger('werkzeug')
log.setLevel(logging.WARNING)

# 全局配置
config = {
    'addr': os.environ.get('WHISPER_ADDR', '127.0.0.1:8088'),
    'token': os.environ.get('WHISPER_TOKEN', ''),
    'model': os.environ.get('WHISPER_MODEL', 'CWTchen/Belle-whisper-large-v3-zh-punct-ct2-float32'),
    'allow_extensions': ['.m4a', '.m4s', '.mp3', '.wav', '.ogg', '.flac', '.aac']
}

if not config['token'].strip():
    raise RuntimeError('请先设置 WHISPER_TOKEN 环境变量作为 Bearer Token')

model = None  # 延迟初始化
model_lock = threading.Lock()  # 保护模型加载/卸载
last_used = None  # 上次使用时间戳
model_loaded_once = False  # 首次加载后置 True，后续重载使用本地缓存
IDLE_TIMEOUT = 300  # 空闲超过5分钟自动卸载模型

# 并发控制，限制同时只能有1个转录任务，1个任务已经足够把GPU打满
transcribe_lock = threading.Semaphore(1)
queue_lock = threading.Lock()
waiting_queue = []  # 等待队列

def init_model():
    """初始化 Whisper 模型（调用前须持有 model_lock）"""
    global model, model_loaded_once
    logger.info(f"正在加载模型: {config['model']} ...")
    # 首次加载允许联网；后续重载（空闲卸载后）只用本地缓存，避免重复请求 HuggingFace API
    model = WhisperModel(config['model'], device="cuda", compute_type="float16", local_files_only=model_loaded_once)
    model_loaded_once = True
    logger.info(f"✓ 模型加载完成")

def ensure_model_loaded():
    """确保模型已加载，并更新最后使用时间"""
    global model, last_used
    with model_lock:
        if model is None:
            logger.info("模型未加载，正在初始化...")
            init_model()
        elif not model.model.model_is_loaded:
            logger.info("模型已从显存卸载，正在重新加载到GPU...")
            model.model.load_model()
            logger.info("✓ 模型已重新加载")
        last_used = time.time()

def idle_monitor():
    """后台线程：模型空闲超过 IDLE_TIMEOUT 秒后自动卸载以释放显存"""
    global model, last_used
    while True:
        time.sleep(60)
        # 尝试非阻塞获取 transcribe_lock，确保当前无转录任务
        if transcribe_lock.acquire(blocking=False):
            try:
                with model_lock:
                    if model is not None and last_used is not None:
                        idle_seconds = time.time() - last_used
                        if idle_seconds > IDLE_TIMEOUT:
                            logger.info(f"模型已空闲 {idle_seconds/60:.1f} 分钟，正在卸载以释放显存...")
                            model.model.unload_model()
                            last_used = None
                            logger.info("✓ 模型已卸载，显存已释放")
            finally:
                transcribe_lock.release()

def get_client_ip():
    """获取客户端标识，兼容 Tailscale Serve 代理场景。

    经源码确认（ipnlocal/serve.go addProxyForwardedHeaders）：
      - X-Forwarded-For: 始终设置为请求方的 Tailscale IP（100.x.x.x），
        包括 tagged device，是获取真实来源的可靠方式。
      - X-Forwarded-Host: 原始 Host header。
      - X-Forwarded-Proto: 仅 HTTPS 时设置为 "https"。
    身份 header（addTailscaleIdentityHeaders，仅非 tagged device）：
      - Tailscale-User-Login: 登录名（如 alice@example.com）
      - Tailscale-User-Name: 显示名
      - Tailscale-User-Profile-Pic: 头像 URL
      - Tailscale-Headers-Info: 固定为文档链接（未写入官方文档）
    """
    remote = request.remote_addr
    # 仅当请求来自本机时才信任代理 header，避免外部伪造
    if remote in ('127.0.0.1', '::1', 'localhost'):
        # X-Forwarded-For 由 Tailscale Serve 始终注入真实 Tailscale IP（含 tagged device），
        # 同时兼容 nginx 等普通反代
        for header in ('X-Forwarded-For', 'X-Real-IP'):
            value = request.headers.get(header, '').strip()
            if value:
                ip = value.split(',')[0].strip()
                if ip:
                    return f"{ip} (via {remote})"
    return remote


def check_auth():
    """检查 Bearer Token 鉴权"""
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return False
    token = auth_header[7:]  # 去掉 "Bearer "
    return bool(config['token']) and token == config['token']

def format_timestamp(seconds):
    """转换秒数为 SRT 时间格式 HH:MM:SS,mmm"""
    td = timedelta(seconds=seconds)
    hours = int(td.total_seconds() // 3600)
    minutes = int((td.total_seconds() % 3600) // 60)
    secs = int(td.total_seconds() % 60)
    millis = int((td.total_seconds() % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

def segments_to_srt(segments):
    """将 Whisper segments 转换为 SRT 格式"""
    srt_lines = []
    for i, segment in enumerate(segments, 1):
        start = format_timestamp(segment.start)
        end = format_timestamp(segment.end)
        text = segment.text.strip()
        srt_lines.append(f"{i}")
        srt_lines.append(f"{start} --> {end}")
        srt_lines.append(text)
        srt_lines.append("")  # 空行分隔
    return "\n".join(srt_lines)

def transcribe_file_streaming(file_path, output_format='text', request_id='unknown'):
    """流式转录音频文件（生成器）

    Args:
        file_path: 音频文件路径
        output_format: 'text' 或 'srt'
        request_id: 请求ID（用于日志）

    Yields:
        dict: 进度更新或最终结果
    """
    logger.info(f"[{request_id}] 开始转录，格式: {output_format}")

    ensure_model_loaded()

    segments_gen, info = model.transcribe(file_path, beam_size=5, vad_filter=True, vad_parameters=dict(min_silence_duration_ms=500), task="transcribe")

    logger.info(f"[{request_id}] 音频时长: {info.duration:.1f}秒")

    # 先发送音频时长信息
    yield {
        'type': 'info',
        'duration': info.duration
    }

    # 流式处理片段，定期发送进度
    segments_list = []
    last_progress_time = time.time()

    for segment in segments_gen:
        segments_list.append(segment)

        # 每3秒发送一次进度
        now = time.time()
        progress_pct = int((segment.end / info.duration) * 100) if info.duration > 0 else 0
        progress_pct = min(progress_pct, 99)

        if now - last_progress_time >= 3:
            yield {
                'type': 'progress',
                'percent': progress_pct
            }
            last_progress_time = now
            logger.info(f"[{request_id}] 转录进度: {progress_pct}%")

    # 最后发送完整结果
    result = {
        'type': 'result',
        'language': info.language,
        'language_probability': info.language_probability,
        'duration': info.duration
    }

    if output_format == 'srt':
        result['srt'] = segments_to_srt(segments_list)
        logger.info(f"[{request_id}] 转录完成，语言: {info.language}，片段数: {len(segments_list)}")
    else:
        result['text'] = " ".join([seg.text for seg in segments_list])
        logger.info(f"[{request_id}] 转录完成，语言: {info.language}，文本长度: {len(result['text'])}字符")

    yield result

def get_queue_position(request_id):
    """获取请求在队列中的位置（从1开始）"""
    with queue_lock:
        try:
            return waiting_queue.index(request_id) + 1
        except ValueError:
            return -1

def add_to_queue(request_id):
    """添加请求到等待队列"""
    with queue_lock:
        waiting_queue.append(request_id)

def remove_from_queue(request_id):
    """从等待队列移除请求"""
    with queue_lock:
        try:
            waiting_queue.remove(request_id)
        except ValueError:
            pass

@app.route('/health', methods=['GET'])
def health():
    """健康检查接口（无需鉴权）"""
    return jsonify({'status': 'ok', 'model': config['model'], 'device': 'cuda'})

@app.route('/version', methods=['GET'])
def version():
    """版本接口（需要鉴权，兼容 Go 版本）"""
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401
    return jsonify({'version': '2.0.0-python'})

@app.route('/transcribe', methods=['POST'])
def transcribe():
    """
    兼容两种模式：
    1. 上传音频文件（multipart/form-data）
    2. 下载 URL 音频（application/json，兼容 Go 版本）
    """
    if not check_auth():
        logger.warning(f"未授权的访问尝试，来自: {get_client_ip()}")
        return jsonify({'error': 'Unauthorized'}), 401

    request_id = f"{int(time.time())}-{threading.get_ident()}"

    # 模式 1: 上传文件（也改为 SSE 流式，带排队提示）
    if request.files and 'audio' in request.files:
        audio_file = request.files['audio']
        file_size = len(audio_file.read())
        audio_file.seek(0)  # 重置文件指针

        logger.info(f"[{request_id}] 收到上传请求，文件大小: {file_size/1024:.1f}KB，来自: {get_client_ip()}")

        # 保存上传的文件到临时位置
        with tempfile.NamedTemporaryFile(delete=False, suffix='.wav') as tmp:
            audio_file.save(tmp.name)
            tmp_path = tmp.name

        def generate_upload():
            """上传文件模式的 SSE 生成器"""
            add_to_queue(request_id)
            queue_pos = get_queue_position(request_id)

            if queue_pos > 0:
                logger.info(f"[{request_id}] 加入队列，位置: {queue_pos}")

            try:
                # 发送排队状态
                while True:
                    pos = get_queue_position(request_id)
                    if pos == -1:
                        break

                    if pos > 0:
                        yield f"event: queue\ndata: {json.dumps({'position': pos})}\n\n"

                    if pos == 1:
                        # 尝试获取锁
                        if transcribe_lock.acquire(blocking=False):
                            remove_from_queue(request_id)
                            logger.info(f"[{request_id}] 开始处理")
                            break

                    time.sleep(0.5)

                # 发送开始转换状态
                yield f"event: converting\ndata: {json.dumps({'status': 'started'})}\n\n"

                try:
                    # 流式转录
                    for update in transcribe_file_streaming(tmp_path, output_format='srt', request_id=request_id):
                        if update['type'] == 'info':
                            # 发送音频信息
                            yield f"event: info\ndata: {json.dumps(update)}\n\n"
                        elif update['type'] == 'progress':
                            # 发送转录进度
                            yield f"event: progress\ndata: {json.dumps(update)}\n\n"
                        elif update['type'] == 'result':
                            # 发送最终结果
                            yield f"event: result\ndata: {json.dumps(update)}\n\n"

                except Exception as e:
                    logger.error(f"[{request_id}] 转录失败: {e}")
                    error_data = {'error': f'Transcription failed: {str(e)}'}
                    yield f"event: error\ndata: {json.dumps(error_data)}\n\n"
                finally:
                    transcribe_lock.release()
            finally:
                remove_from_queue(request_id)
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)

        return Response(generate_upload(), mimetype='text/event-stream')

    # 模式 2: 下载 URL（SSE 流式，带排队通知）
    data = request.get_json()
    if not data or 'url' not in data:
        return jsonify({'error': 'Missing audio file or url parameter'}), 400

    url = data['url']
    headers = data.get('headers', {})

    logger.info(f"[{request_id}] 收到URL请求: {url[:80]}..., 来自: {get_client_ip()}")

    # 检查文件扩展名
    url_path = url.split('?')[0].lower()
    if not any(url_path.endswith(ext) for ext in config['allow_extensions']):
        logger.warning(f"[{request_id}] 不支持的文件扩展名: {url_path}")
        return jsonify({'error': f'Unsupported file extension. Allowed: {config["allow_extensions"]}'}), 400

    def generate_url():
        """下载 URL 模式的 SSE 生成器"""
        add_to_queue(request_id)
        queue_pos = get_queue_position(request_id)

        if queue_pos > 0:
            logger.info(f"[{request_id}] 加入队列，位置: {queue_pos}")

        try:
            # 发送排队状态
            while True:
                pos = get_queue_position(request_id)
                if pos == -1:
                    break
                yield f"event: queue\ndata: {json.dumps({'position': pos})}\n\n"

                if pos == 1:
                    # 尝试获取锁
                    if transcribe_lock.acquire(blocking=False):
                        remove_from_queue(request_id)
                        logger.info(f"[{request_id}] 开始处理")
                        break

                time.sleep(0.5)

            # 发送开始转换状态
            yield f"event: converting\ndata: {json.dumps({'status': 'started'})}\n\n"

            # 下载音频文件
            ext = os.path.splitext(url_path)[1] or '.m4a'
            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
                tmp_path = tmp.name

            try:
                # 下载
                logger.info(f"[{request_id}] 开始下载音频")
                resp = requests.get(url, headers=headers, stream=True, timeout=60)
                resp.raise_for_status()

                downloaded_size = 0
                with open(tmp_path, 'wb') as f:
                    for chunk in resp.iter_content(chunk_size=8192):
                        f.write(chunk)
                        downloaded_size += len(chunk)

                logger.info(f"[{request_id}] 下载完成，大小: {downloaded_size/1024:.1f}KB")

                # 发送下载完成状态
                yield f"event: converting\ndata: {json.dumps({'status': 'downloaded'})}\n\n"

                # 流式转录（返回 SRT 格式，兼容 Go 版本）
                for update in transcribe_file_streaming(tmp_path, output_format='srt', request_id=request_id):
                    if update['type'] == 'info':
                        # 发送音频信息
                        yield f"event: info\ndata: {json.dumps(update)}\n\n"
                    elif update['type'] == 'progress':
                        # 发送转录进度
                        yield f"event: progress\ndata: {json.dumps(update)}\n\n"
                    elif update['type'] == 'result':
                        # 发送最终结果
                        yield f"event: result\ndata: {json.dumps(update)}\n\n"

            except requests.RequestException as e:
                logger.error(f"[{request_id}] 下载失败: {e}")
                error_data = {'error': f'Download failed: {str(e)}'}
                yield f"event: error\ndata: {json.dumps(error_data)}\n\n"
            except Exception as e:
                logger.error(f"[{request_id}] 转录失败: {e}")
                error_data = {'error': f'Transcription failed: {str(e)}'}
                yield f"event: error\ndata: {json.dumps(error_data)}\n\n"
            finally:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
                transcribe_lock.release()
        finally:
            remove_from_queue(request_id)

    return Response(generate_url(), mimetype='text/event-stream')

# Ctrl+C 信号处理：首次释放显存，再次退出进程
_last_sigint_time = None
_DOUBLE_CTRL_C_INTERVAL = 3  # 两次 Ctrl+C 的最大间隔秒数

def _sigint_handler(signum, frame):
    global _last_sigint_time, last_used
    now = time.time()
    if _last_sigint_time is not None and (now - _last_sigint_time) < _DOUBLE_CTRL_C_INTERVAL:
        print()
        logger.info("收到第二次 Ctrl+C，正在退出进程...")
        sys.exit(0)
    _last_sigint_time = now
    print()  # 换行，避免 '^C' 和日志混排
    with model_lock:
        if model is not None:
            try:
                if model.model.model_is_loaded:
                    logger.info("收到 Ctrl+C，正在释放显存...")
                    model.model.unload_model()
                    last_used = None
                    logger.info(f"✓ 显存已释放。{_DOUBLE_CTRL_C_INTERVAL} 秒内再次按 Ctrl+C 退出进程。")
                else:
                    logger.info(f"收到 Ctrl+C，模型已不在显存中。{_DOUBLE_CTRL_C_INTERVAL} 秒内再次按 Ctrl+C 退出进程。")
            except Exception as e:
                logger.warning(f"释放显存时出错: {e}")
                logger.info(f"{_DOUBLE_CTRL_C_INTERVAL} 秒内再次按 Ctrl+C 退出进程。")
        else:
            logger.info(f"收到 Ctrl+C，模型未加载。{_DOUBLE_CTRL_C_INTERVAL} 秒内再次按 Ctrl+C 退出进程。")


def _load_tray_icon_image():
    """优先加载本目录下 tray.ico，否则使用纯色默认图标"""
    icon_path = os.path.join(BASE_DIR, 'tray.ico')
    if os.path.isfile(icon_path):
        return Image.open(icon_path)
    return Image.new('RGBA', (64, 64), '#3578e5')

def _tray_status(_item):
    """托盘菜单：显示当前模型状态（作为动态菜单项文本时使用）

    pystray 将 MenuItem 的 text 回调视为 property：只传入 item 自身，不传 icon。
    """
    with model_lock:
        if model is None:
            return "状态: 未加载"
        try:
            if model.model.model_is_loaded:
                return "状态: 已加载 (显存中)"
            return "状态: 已卸载 (待唤醒)"
        except Exception:
            return "状态: 未知"

_last_tray_click = 0.0
_DOUBLE_CLICK_INTERVAL = 0.5  # 秒；两次单击落在此区间内视为双击

def _open_log_window():
    """打开一个 PowerShell 窗口 tail -f 日志文件"""
    ps_cmd = (
        f"$Host.UI.RawUI.WindowTitle = 'Whisper Server Logs'; "
        f"Get-Content -Path '{_log_file}' -Wait -Tail 200 -Encoding UTF8"
    )
    try:
        subprocess.Popen(
            ['powershell.exe', '-NoProfile', '-NoExit', '-Command', ps_cmd],
            creationflags=subprocess.CREATE_NEW_CONSOLE,
            close_fds=True,
        )
    except Exception as e:
        logger.error(f"打开日志窗口失败: {e}")

def _tray_show_logs(_icon=None, _item=None):
    """托盘默认动作。pystray win32 会在单击时触发；这里做双击去抖。"""
    global _last_tray_click
    now = time.monotonic()
    if now - _last_tray_click < _DOUBLE_CLICK_INTERVAL:
        _last_tray_click = 0.0  # 重置，避免第三次点击又秒开
        # subprocess.Popen 启动 powershell.exe 在系统繁忙时可能耗时数百毫秒，
        # 放到后台线程避免阻塞 pystray 消息循环导致托盘无响应
        threading.Thread(target=_open_log_window, daemon=True).start()
    else:
        _last_tray_click = now

def _tray_unload_model(_icon, _item):
    """托盘菜单：手动卸载模型释放显存"""
    global last_used
    if not transcribe_lock.acquire(blocking=False):
        logger.info("有转录任务正在进行，忽略卸载请求")
        return
    try:
        with model_lock:
            if model is not None:
                try:
                    if model.model.model_is_loaded:
                        logger.info("托盘触发：正在释放显存...")
                        model.model.unload_model()
                        last_used = None
                        logger.info("✓ 显存已释放")
                    else:
                        logger.info("模型已不在显存中")
                except Exception as e:
                    logger.warning(f"释放显存时出错: {e}")
            else:
                logger.info("模型未加载")
    finally:
        transcribe_lock.release()

def _tray_quit(icon, _item):
    """托盘菜单：退出程序

    在 pystray 回调线程里直接 os._exit() 会导致托盘图标残留：Windows 从未收到
    Shell_NotifyIcon(NIM_DELETE)。正确做法是丢到后台线程完成卸载，再 icon.stop()，
    让消息循环走完清理流程，主线程从 tray_icon.run() 返回后进程自然退出
    （其它工作线程都是 daemon）。
    """
    logger.info("托盘触发：正在退出...")

    def shutdown():
        with model_lock:
            if model is not None:
                try:
                    if model.model.model_is_loaded:
                        model.model.unload_model()
                        logger.info("✓ 显存已释放")
                except Exception as e:
                    logger.warning(f"释放显存时出错: {e}")
        icon.stop()

    threading.Thread(target=shutdown, daemon=True).start()

def _run_server(host, port):
    """在后台线程中运行 waitress 服务"""
    from waitress import serve
    try:
        serve(app, host=host, port=port, threads=4)
    except Exception as e:
        logger.error(f"服务异常退出: {e}")


def _startup_worker(host, port):
    """后台启动流程：加载模型 -> 启动 idle 监控 -> 启动 HTTP 服务

    放在托盘之后异步执行，让托盘图标能够第一时间显示。
    """
    try:
        ensure_model_loaded()
        monitor_thread = threading.Thread(target=idle_monitor, daemon=True)
        monitor_thread.start()
        logger.info(f"模型空闲超过 {IDLE_TIMEOUT//60} 分钟将自动卸载")

        logger.info("=" * 60)
        logger.info("Whisper Server Enhanced (Python)")
        logger.info("=" * 60)
        logger.info(f"Model: {config['model']} (CUDA)")
        logger.info(f"Listening on: http://{host}:{port}")
        logger.info("Endpoints:")
        logger.info("  GET  /health           - Health check (no auth)")
        logger.info("  GET  /version          - Version info (auth required)")
        logger.info("  POST /transcribe       - Upload audio OR download URL (SSE)")
        logger.info("=" * 60)

        _run_server(host, port)
    except Exception:
        logger.exception("启动流程失败")


if __name__ == '__main__':
    # 注册 Ctrl+C 信号处理（.pyw 无控制台时不会触发，仅在通过 python.exe 运行时有效）
    signal.signal(signal.SIGINT, _sigint_handler)

    # 解析监听地址
    addr_parts = config['addr'].split(':')
    if len(addr_parts) == 2:
        host, port = addr_parts[0] or '0.0.0.0', int(addr_parts[1])
    else:
        host, port = '0.0.0.0', int(addr_parts[0])

    # 后台线程执行模型加载 + HTTP 服务启动，避免阻塞托盘图标显示
    # 但不能太早启动：Whisper CUDA 加载会重度占用 GIL 数秒，会饿死 pystray 的
    # setup 线程，导致 Shell_NotifyIcon(NIM_ADD) 迟迟不发、图标看似不出现。
    # 因此改到 tray_icon.run(setup=...) 回调里启动，确保图标先注册。

    # 构建托盘菜单
    # default=True 的菜单项会在双击托盘图标时触发（pystray 在 win32 下的约定）
    menu = pystray.Menu(
        pystray.MenuItem(_tray_status, None, enabled=False),
        pystray.MenuItem(f"监听: {host}:{port}", None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("查看日志", _tray_show_logs, default=True),
        pystray.MenuItem("卸载模型 (释放显存)", _tray_unload_model),
        pystray.MenuItem("退出", _tray_quit),
    )
    tray_icon = pystray.Icon(
        "whisper_server",
        icon=_load_tray_icon_image(),
        title=f"Whisper Server ({host}:{port})",
        menu=menu,
    )

    def _on_tray_ready(icon):
        """pystray 已启动消息循环之后回调。

        注意：部分 pystray 版本在传入自定义 setup 时不会自动把 visible 置为 True，
        必须在回调里显式设置，否则 Shell_NotifyIcon(NIM_ADD) 永远不会发出，图标不会出现。
        """
        icon.visible = True
        logger.info("✓ 托盘图标已注册（若托盘看不见，请在通知区域溢出中查看或将其固定）")
        threading.Thread(target=_startup_worker, args=(host, port), daemon=True).start()

    tray_icon.run(setup=_on_tray_ready)
