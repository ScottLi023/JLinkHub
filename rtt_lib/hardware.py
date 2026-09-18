"""设备通信基类 — 数据队列、回调、时间戳、波形数据解析。

供 JlinkRTT 等子类继承，提供：
  * 错误/警告回调（err_cb、warn_cb）
  * 接收数据队列（data_queue）
  * 可选时间戳添加
  * TAG=DLOG 波形数据解析（可选回调）
"""

import re
import threading
from queue import Queue
from datetime import datetime


class DeviceBase:
    """硬件通信设备基类。

    子类需实现：open()、close()、is_open()、read()、write(data)。

    Attributes:
        err_cb: 错误回调 (msg: str) → None
        warn_cb: 警告回调 (msg: str) → None
        char_format: 数据格式（'asc' / 'utf-8' / 'gb2312'）
        interval: 数据轮询间隔（秒）
        data_queue: 接收到的数据队列（Queue[str]）
    """

    def __init__(self, err_cb, warn_cb, interval: float = 0.002, char_format: str = 'asc'):
        self.err_cb = err_cb
        self.warn_cb = warn_cb
        self.char_format = char_format
        self.interval = interval
        self.data_queue: Queue[str] = Queue()
        self._timestamp = False
        self._remain = ''          # 时间戳行缓冲
        self._rx_buf = ''          # 波形数据累积缓冲
        self._tag_timeout = 0
        self._tag_timeout_init = int(6 / interval)
        self._dlog_callbacks: list = []
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ 子类接口
    def open(self, **kwargs) -> bool:
        raise NotImplementedError

    def close(self):
        raise NotImplementedError

    def is_open(self) -> bool:
        raise NotImplementedError

    def write(self, data):
        raise NotImplementedError

    def read(self):
        raise NotImplementedError

    # ------------------------------------------------------------------ 数据处理
    def _handle_data(self, text: str):
        """接收原始数据，可选添加时间戳后入队列，并解析波形数据。"""
        if not text:
            return
        if self._timestamp:
            text, self._remain = self._add_timestamp(self._remain + text)
        self.data_queue.put(text)
        self._process_dlog(text)

    def _add_timestamp(self, text: str) -> tuple:
        """每行前添加时间戳。返回 (带时间戳文本, 未完成行缓冲)。"""
        ts = '[' + datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3] + '] '
        text = text.replace('\r\n', '\n').replace('\r', '')
        lines = text.splitlines(keepends=True)
        result, buf = [], ''
        for line in lines:
            if line.endswith('\n'):
                if buf:
                    line = buf + line
                    buf = ''
                result.append(ts + line)
            else:
                buf += line
        return ''.join(result), buf

    def _process_dlog(self, text: str):
        """处理 TAG=DLOG M*N(x,y,z) 格式的波形数据。"""
        self._rx_buf += text
        if len(self._rx_buf) <= 10:
            return
        tags = re.findall(r'(TAG=DLOG.+?\n)', self._rx_buf)
        for tag in tags:
            self._handle_dlog_packet(tag)
        if tags:
            last = self._rx_buf.rfind('TAG=DLOG')
            end = self._rx_buf.find('\n', last)
            self._rx_buf = self._rx_buf[end + 1:] if end >= 0 else ''
            self._tag_timeout = self._tag_timeout_init
        elif self._tag_timeout > 0:
            self._tag_timeout -= 1
        else:
            self._rx_buf = ''

    def _handle_dlog_packet(self, packet: str):
        """解析 TAG=DLOG M*N(x,y,z) 波形数据并通知回调。"""
        m = re.search(r'M\*(\d+)\((-?\d+\.?\d*),(-?\d+\.?\d*),(-?\d+\.?\d*)\)', packet)
        if not m:
            return
        n = int(m.group(1))
        values = []
        for i in range(2, 5):
            v = int(m.group(i))
            values.append(v / (10 ** n) if n else v)
        with self._lock:
            callbacks = list(self._dlog_callbacks)
        for cb in callbacks:
            try:
                cb(values)
            except Exception as e:
                self.warn_cb(f"波形回调异常: {e}")

    # ------------------------------------------------------------------ 工具方法
    def reset_state(self):
        """重置内部状态（连接前调用）。"""
        self._rx_buf = ''
        self._remain = ''
        # Queue.queue 不是公开接口，清空时同时持有 Queue 自己的 mutex，
        # 避免 RTT 读取线程正在取数据时发生竞态。
        with self.data_queue.mutex:
            self.data_queue.queue.clear()

    def read_data_queue(self, out: list):
        """从队列取出所有已就绪的数据追加到 out 列表。"""
        while not self.data_queue.empty():
            out.append(self.data_queue.get())

    def enable_timestamp(self, on: bool = True):
        """开启/关闭时间戳。"""
        self._timestamp = on

    def register_dlog_callback(self, cb):
        """注册波形数据回调。"""
        with self._lock:
            self._dlog_callbacks.append(cb)
