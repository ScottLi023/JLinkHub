#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
web_console.py — STM32 J-Link 网页调试控制台（独立版）

功能:
  * 网页选择 STM32 芯片（系列 + 型号级联）、通讯速率、复位模式，连接/断开 J-Link
  * RTT 日志实时推送到浏览器（BDSCOL 颜色标签 → ANSI → 前端渲染彩色）
  * 浏览器上传固件 → 调用 pylink 烧录 → 进度实时推送

技术栈: Flask（静态页 + REST API）+ websockets（实时推送）+ pylink / rtt_lib

用法:
    python3 web_console.py [--host 0.0.0.0] [--port 8080] [--ws-port 8765]

环境变量:
    JLINK_LIB   显式指定 libjlinkarm.so 路径（一般不需要）
    WEB_HOST / WEB_PORT / WS_PORT  监听地址与端口
"""

import argparse
import asyncio
import json
import os
import re
import sys
import tempfile
import threading
import time

# ---- 复用 rtt_lib（RTT 通信库） ----
# rtt_lib/jlink.py: J-Link RTT 读取类
# rtt_lib/hardware.py: 硬件基类（数据队列、回调处理）
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RTT_LIB_DIR = os.path.join(SCRIPT_DIR, 'rtt_lib')
if RTT_LIB_DIR not in sys.path:
    sys.path.insert(0, RTT_LIB_DIR)

import pylink  # noqa: E402
from jlink import JlinkRTT  # noqa: E402

from flask import Flask, jsonify, request, send_from_directory  # noqa: E402
import websockets  # noqa: E402

# ============================================================
# 配置
# ============================================================

WEB_DIR = os.path.join(SCRIPT_DIR, 'web')
MODELS_FILE = os.path.join(WEB_DIR, 'stm32_models.json')
UPLOAD_DIR = os.path.join(tempfile.gettempdir(), 'jlink_web_uploads')

JLINK_LIB = os.getenv("JLINK_LIB", "") or None
WEB_HOST = os.getenv("WEB_HOST", "0.0.0.0")
WEB_PORT = int(os.getenv("WEB_PORT", "8080"))
WS_PORT = int(os.getenv("WS_PORT", "8765"))

READ_INTERVAL = 0.002          # RTT 轮询间隔（秒），与 rtt_tcp_server 一致
RTT_SEARCH_START = None        # 留空 → J-Link 自动搜索 _SEGGER_RTT
RTT_SEARCH_RANGE = 0
FLASH_MAX_ATTEMPTS = 3         # 闪存操作中断性故障（halt/RAMCode 下载失败）的重试次数

ALLOWED_FW_TYPES = ('bin', 'hex', 'elf', 'axf')
ERASE_FILL_MAX = 0x800000      # 区域擦除（0xFF 填充）单次上限 8MB，防误填超大地块

# ============================================================
# 日志
# ============================================================

def log(msg):
    print(time.strftime("[%Y-%m-%d %H:%M:%S]"), msg, flush=True)


# ============================================================
# BDSCOL 颜色标签 → ANSI 真彩色（与 rtt_tcp_server 语义一致）
# ============================================================

COLOR_PAT = re.compile(r'BDSCOL\((\d{1,8})\)', re.I)
TAG_PAT = re.compile(r'BDSCOL\(\d{1,8}\)', re.I)
INCOMPLETE_TAG_PAT = re.compile(r'BDSCOL\(\d{0,8}$', re.I)
FLUSH_IDLE_S = 0.3
TAG_GRACE_S = 1.0


def _rgb_to_ansi(rgb):
    return '\x1b[38;2;%d;%d;%dm' % ((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF)


class ColorConverter:
    """把 RTT 流按行处理: BDSCOL 标签 → ANSI 颜色, 不完整行超时冲刷。

    与 rtt_tcp_server.ColorConverter 相同 —— 复制自该文件（有意复用）。
    """

    def __init__(self, flush_idle_s=FLUSH_IDLE_S):
        self.flush_idle_s = flush_idle_s
        self.buf = ''
        self.last_data_t = 0.0
        self.tag_grace_until = 0.0

    def feed(self, s):
        self.buf += s
        self.last_data_t = time.monotonic()
        return self._drain(include_tail=False)

    def tick(self):
        if not self.buf:
            return ''
        now = time.monotonic()
        if now - self.last_data_t < self.flush_idle_s:
            return ''
        if INCOMPLETE_TAG_PAT.search(self.buf):
            if self.tag_grace_until == 0.0:
                self.tag_grace_until = now + TAG_GRACE_S
                return ''
            if now < self.tag_grace_until:
                return ''
            out = self._drain(include_tail=True)
            self.tag_grace_until = 0.0
            return out
        self.tag_grace_until = 0.0
        return self._drain(include_tail=True)

    def _drain(self, include_tail):
        out = []
        while True:
            idx = self.buf.find('\n')
            if idx < 0:
                break
            line, self.buf = self.buf[:idx + 1], self.buf[idx + 1:]
            out.append(self._convert(line))
        if include_tail and self.buf:
            out.append(self._convert(self.buf))
            self.buf = ''
        return ''.join(out)

    @staticmethod
    def _convert(line):
        m = COLOR_PAT.search(line)
        if m is None:
            return line
        text = TAG_PAT.sub('', line)
        if text.endswith('\n'):
            text = text[:-1] + '\x1b[0m\n'
        else:
            text = text + '\x1b[0m'
        return _rgb_to_ansi(int(m.group(1))) + text


# ============================================================
# WebSocket 广播中枢（线程安全，可从任意线程调用）
# ============================================================

class WsHub:
    """WebSocket 消息中枢（一对一，不广播）。

    * attach(ws, session_id) 绑定 session → ws
    * broadcast(payload, session_id) 只发给该会话；
      session 不存在时消息丢弃（绝不发给其他浏览器）
    """

    def __init__(self):
        self.sessions = {}        # session_id -> ws
        self.lock = threading.Lock()
        self.loop = None

    def attach(self, ws, session_id=None):
        with self.lock:
            if session_id:
                self.sessions[session_id] = ws
            if self.loop is None:
                self.loop = ws.loop if hasattr(ws, 'loop') else None

    def detach(self, ws):
        with self.lock:
            # 移除该 ws 对应的所有 session 绑定
            for sid, w in list(self.sessions.items()):
                if w is ws:
                    del self.sessions[sid]

    def set_loop(self, loop):
        with self.lock:
            self.loop = loop

    def _serialize(self, payload):
        if isinstance(payload, dict):
            # 容错：bytes 等不可序列化值转成 str，避免 ctypes 回调里崩溃
            def _clean(v):
                if isinstance(v, bytes):
                    return v.decode('utf-8', errors='replace')
                if isinstance(v, dict):
                    return {k: _clean(x) for k, x in v.items()}
                if isinstance(v, (list, tuple)):
                    return [_clean(x) for x in v]
                return v
            try:
                return json.dumps(_clean(payload), ensure_ascii=False)
            except TypeError:
                return json.dumps(str(payload), ensure_ascii=False)
        return str(payload)

    def send(self, payload, session_id):
        """线程安全发送 JSON 消息到指定会话（一对一）。

        session_id 为 None 或会话不存在时静默丢弃，不向任何其他浏览器发送。
        """
        if session_id is None:
            return
        message = self._serialize(payload)
        with self.lock:
            loop = self.loop
            ws = self.sessions.get(session_id)
        if ws is None or loop is None:
            return

        async def _send():
            try:
                await ws.send(message)
            except Exception:
                pass

        try:
            asyncio.run_coroutine_threadsafe(_send(), loop)
        except RuntimeError:
            pass

    def send_log(self, text, session_id=None):
        self.send({"type": "log", "data": text}, session_id)


hub = WsHub()


# ============================================================
# J-Link 后端：复用 rtt_lib 的 JlinkRTT，支持设备名解析与重连
# ============================================================

class JlinkServer(JlinkRTT):
    """扩展 JlinkRTT，支持显式指定 J-Link 动态库路径（pylink 2.x）。"""

    def __init__(self, err_cb, warn_cb, jlink_lib=None, **kwargs):
        orig_jlink = None
        if jlink_lib:
            from pylink.library import Library
            orig_jlink = pylink.JLink
            pylink.JLink = lambda *a, **kw: orig_jlink(lib=Library(dllpath=jlink_lib), *a, **kw)
        try:
            super().__init__(err_cb, warn_cb, **kwargs)
        finally:
            if orig_jlink is not None:
                pylink.JLink = orig_jlink


def _normalize(name):
    return re.sub(r'[^A-Z0-9]', '', name.upper())


def _parse_addr(v):
    """解析地址：接受 int / "0x08000000" / "08000000" 等，失败抛 ValueError。"""
    if isinstance(v, bool):
        raise ValueError
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip()
    try:
        return int(s, 0)
    except ValueError:
        return int(s, 16)


def _device_candidates(model):
    """由用户选择的型号生成候选 J-Link 设备名列表。

    封装/温度后缀规则：C8T6 → C8、CBT6 → CB、VGT6 → VG、ZET6 → ZE
    （J-Link 识别的是去掉封装+温度后缀的代码）。
    """
    m = model.strip()
    cands = [m, m.upper()]
    mm = re.match(r'^(STM32[A-Z0-9]+?)([A-Z]{1,2}\d[A-Z]\d|[A-Z]{1,3}\d)$', m.upper())
    if mm:
        base = mm.group(1)
        code = mm.group(2)
        cands.append(base + code[:2])  # 去掉引脚/温度后缀
    # 去重保持顺序
    return list(dict.fromkeys(cands))


class JlinkManager:
    """管理 J-Link 连接生命周期: 连接/断开/读取线程/烧录。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.dll_lock = threading.Lock()  # 串行化所有 J-Link DLL 调用（DLL 非线程安全）
        self.hw = None
        self.reading = False
        self.reader_thread = None
        self.chip = None
        self.speed = None
        self.converter = ColorConverter()
        self.supported = None  # J-Link 支持的设备列表缓存
        self.last_sn = None
        self.log_session = None  # 当前日志推送的目标会话（一对一）
        self.is_flashing = False  # 烧录互斥：烧录期间拒绝并发请求并暂停 RTT 读取

    # ---------- 设备列表 ----------

    def get_supported_devices(self):
        """从 J-Link DLL 获取支持的设备列表（失败返回 None）。

        pylink 2.x API：num_supported_devices() 取数量，supported_device(i) 取单个。
        """
        if self.supported is not None:
            return self.supported
        try:
            jl = pylink.JLink()
            n = jl.num_supported_devices()
            devs = [jl.supported_device(i).name for i in range(n)]
            self.supported = devs
            return devs
        except Exception:
            return None

    def resolve_device(self, model):
        """把型号解析为 J-Link 认识的设备名（优先匹配 supported_devices）。"""
        cands = _device_candidates(model)
        supported = self.get_supported_devices()
        if supported:
            sup_norm = {_normalize(d): d for d in supported}
            # 精确匹配
            for c in cands:
                if _normalize(c) in sup_norm:
                    return sup_norm[_normalize(c)]
            # 前缀匹配（J-Link 设备名可能带额外信息，如封装/温度后缀），
            # 遍历全部候选：只拿全型号（cands[0]）做前缀永远匹配不上只收短型号的库
            for c in cands:
                cn = _normalize(c)
                for dev in supported:
                    if _normalize(dev).startswith(cn):
                        return dev
        return cands[0]  # 兜底: 直接传完整型号

    # ---------- 状态 ----------

    def status(self):
        with self.lock:
            hw = self.hw
            chip, speed, reading = self.chip, self.speed, self.reading
        with self.dll_lock:
            hw_open = hw is not None and hw.is_open()
            sn = hw.serial_number if hw_open else None
        return {
            "connected": hw_open,
            "chip": chip,
            "speed": speed,
            "probe_sn": sn,
            "reading": reading,
        }

    # ---------- 连接 / 断开 ----------

    def connect(self, chip, speed, reset=True, session_id=None):
        with self.lock:
            with self.dll_lock:
                if self.hw is not None and self.hw.is_open():
                    return {"ok": False, "error": "J-Link 已连接，请先断开"}

            # 提前绑定会话，确保连接过程中的错误/状态也定向发送
            self.log_session = session_id
            # 候选顺序：先试 resolve_device 解析出的设备名（已按 J-Link 数据库匹配，
            # 如 STM32F407ZGT6 → STM32F407ZG），再兜底原始候选。避免把带封装/温度后缀的
            # 全型号先喂给 DLL 触发 "Unsupported device selected." 报错噪音
            # （数据库通常只收录短型号，如 GD32 则相反只收全型号）。
            cands = list(dict.fromkeys([self.resolve_device(chip)] + _device_candidates(chip)))
            # 逐个尝试期间静默记录错误（不推送红色提示），全部失败后统一返回一次
            attempt_err = {"msg": None}

            def quiet_err(msg):
                msg = msg.strip()
                if msg.startswith("J-Link 连接失败: "):
                    msg = msg[len("J-Link 连接失败: "):]
                attempt_err["msg"] = msg
                log(f"J-Link 尝试失败: {msg}")

            hw = JlinkServer(err_cb=quiet_err, warn_cb=self._warn_cb,
                             jlink_lib=JLINK_LIB, chip=cands[0], speed=speed,
                             interval=READ_INTERVAL,
                             char_format='asc')

            # 依次尝试候选设备名
            last_err = None
            for dev in cands:
                try:
                    ok = hw.open(speed=speed, chip=dev, reset=reset,
                                 start_address=RTT_SEARCH_START,
                                 range_size=RTT_SEARCH_RANGE,
                                 sn=None)
                    if ok:
                        device = dev
                        break
                except Exception as e:
                    last_err = str(e)
                    ok = False

            if not ok:
                try:
                    hw.close()
                except Exception:
                    pass
                self.log_session = None
                err_msg = last_err or attempt_err["msg"] or "未知错误"
                log(f"J-Link 连接失败: {err_msg}")
                return {"ok": False, "error": "连接失败: %s" % err_msg}

            hw.err_cb = self._err_cb  # 连接成功后恢复实时错误回调（RTT 读取等错误仍推送给会话）
            self.hw = hw
            self.chip = chip
            self.speed = speed
            self.reading = True
            self.reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
            self.reader_thread.start()
            log(f"J-Link 已连接: SN={hw.serial_number}, 设备={device}, {speed} kHz "
                f"(会话 {session_id or '无'})")
            return {"ok": True, "device": device, "sn": hw.serial_number}

    def disconnect(self):
        with self.lock:
            self.reading = False
            hw = self.hw
            self.hw = None
            self.chip = None
            self.speed = None
            self.log_session = None
        if hw is not None:
            try:
                with self.dll_lock:
                    hw.close()
            except Exception:
                pass
            log("J-Link 已断开")
        return {"ok": True}

    # ---------- 回调 ----------

    def _err_cb(self, msg):
        # 错误消息只发给当前日志会话（一对一）；无会话时仅记录，不广播给所有人。
        # 注意：此回调可能在 connect/reader 持 self.lock 时被调用（pylink 回调），
        # 因此这里直接读取 log_session（str/None 原子读），绝不能再去获取 self.lock，否则死锁。
        session = self.log_session
        if session is not None:
            hub.send({"type": "error", "message": msg.strip()}, session_id=session)
        log(f"RTT 错误: {msg.strip()}")

    def _warn_cb(self, msg):
        log(f"RTT 警告: {msg.strip()}")

    # ---------- 读取线程 ----------

    def _reader_loop(self):
        while self.reading:
            # 烧录期间暂停 RTT 读取；所有 DLL 调用经 dll_lock 串行，杜绝与擦除/烧录并发
            if self.is_flashing:
                time.sleep(0.05)
                continue
            hw = self.hw
            session = self.log_session  # log_session 原子读（str/None），无需加锁
            try:
                with self.dll_lock:
                    if hw is None or not hw.is_open():
                        time.sleep(0.05)
                        continue
                    hw.read()
                chunks = []
                hw.read_data_queue(chunks)
                for chunk in chunks:
                    out = self.converter.feed(chunk)
                    if out:
                        hub.send_log(out, session_id=session)
                out = self.converter.tick()
                if out:
                    hub.send_log(out, session_id=session)
            except Exception as e:
                log(f"读取异常: {e}")
                hub.send({"type": "error", "message": "RTT 读取异常: {e}"}, session_id=session)
                time.sleep(0.5)
            time.sleep(READ_INTERVAL)

    # ---------- 上行写入 ----------

    def write(self, data):
        with self.lock:
            hw = self.hw
        try:
            with self.dll_lock:
                if hw is None or not hw.is_open():
                    return False
                hw.write(list(data))
            return True
        except Exception as e:
            log(f"上行写入失败: {e}")
            return False

    # ---------- 复位 ----------

    def reset(self):
        with self.lock:
            hw = self.hw
        try:
            with self.dll_lock:
                if hw is None or not hw.is_open():
                    return {"ok": False, "error": "J-Link 未连接"}
                hw.jlink.reset(ms=10, halt=False)
            log("MCU 已复位")
            return {"ok": True}
        except Exception as e:
            log(f"MCU 复位失败: {e}")
            return {"ok": False, "error": str(e)}

    # ---------- 擦除 / 烧录 ----------

    def flash(self, firmware_path, file_type='bin', erase=False, program=True,
              region=None, full_chip=False, session_id=None):
        """在独立线程中执行擦除/烧录，进度经 WebSocket 定向推送给发起会话。

        区域配置：region = {"name", "start", "end"}；full_chip 表示选中的是全量整片预设
        （擦除走原生整片擦除，速度快）。
        操作顺序：先擦除、后烧录；烧录成功后自动复位，仅擦除不复位。

        烧录互斥：is_flashing 置位期间拒绝新的请求，且读取线程暂停；
        所有 DLL 调用经 dll_lock 串行，杜绝与读取线程并发（DLL 非线程安全）。
        """
        with self.lock:
            if self.is_flashing:
                return {"ok": False, "error": "擦除/烧录正在进行中，请等待完成"}
            with self.dll_lock:
                if self.hw is None or not self.hw.is_open():
                    return {"ok": False, "error": "J-Link 未连接"}
            hw = self.hw
            if session_id is None:
                session_id = self.log_session
            self.is_flashing = True

        if program and not os.path.exists(firmware_path):
            with self.lock:
                self.is_flashing = False
            return {"ok": False, "error": f"固件文件不存在: {firmware_path}"}

        region = region or {}
        rstart = region.get('start', 0x08000000)
        rend = region.get('end', rstart + 0x100000)
        ops = ('擦除' if erase else '') + ('并烧录' if erase and program else '烧录' if program else '')
        fw_label = os.path.basename(firmware_path) if firmware_path else '（无固件，仅擦除）'

        hub.send({"type": "flash", "stage": "准备", "percent": 0,
                       "message": f"开始{ops}: {fw_label}"
                                  f"（区域 {region.get('name', '全量整片')} 0x{rstart:08X}~0x{rend:08X}）"},
                      session_id=session_id)
        log(f"开始{ops}: {firmware_path or '（无固件）'} [{region.get('name', '全量整片')} "
            f"0x{rstart:08X}~0x{rend:08X}] erase={erase} program={program} full_chip={full_chip}")

        def progress(action, progress_string, percentage):
            # pylink 回调的 progress_string 是 bytes，需解码为 str
            if isinstance(progress_string, bytes):
                progress_string = progress_string.decode('utf-8', errors='replace')
            hub.send({"type": "flash", "stage": action,
                           "percent": percentage, "message": progress_string},
                          session_id=session_id)
            log(f"烧录进度: {action} - {progress_string} ({percentage}%)")

        def worker():
            try:
                # 整个擦除/烧录/复位期间独占 J-Link DLL（DLL 非线程安全），
                # 读取线程会阻塞在 dll_lock 上，杜绝与 rtt_read 的并发调用；
                # 执行期间 J-Link 可能被用户断开，进入锁后先确认一次
                with self.dll_lock:
                    if hw is None or not hw.is_open():
                        hub.send({"type": "flash_done", "ok": False,
                                  "message": "操作失败: J-Link 已断开"},
                                 session_id=session_id)
                        return

                    # 擦除/烧录前暂停 RTT：RTT 启动后 J-Link 会在后台持续轮询
                    # 目标 RAM 缓冲，与 RAMCode 下载竞争同一调试口，偶发
                    # "Verification of RAMCode failed"；操作结束后恢复，日志不间断
                    rtt_was_running = hw._rtt_started
                    if rtt_was_running:
                        try:
                            hw.jlink.rtt_stop()
                        except Exception:
                            pass
                        hw._rtt_started = False

                    try:
                        # 中断性故障自动重试：本套探针偶发 halt / RAMCode 下载失败
                        # （"Verification of RAMCode failed"），失败后复位并暂停内核重试
                        last_err = None
                        for attempt in range(1, FLASH_MAX_ATTEMPTS + 1):
                            if attempt > 1:
                                log(f"闪存操作第 {attempt - 1} 次尝试失败，复位后重试"
                                    f"（{attempt}/{FLASH_MAX_ATTEMPTS}）")
                                try:
                                    hw.jlink.reset(ms=10, halt=True)
                                except Exception:
                                    pass
                                time.sleep(0.3)
                            try:
                                done = []

                                # 1) 擦除（先擦后烧，保证干净起始状态）
                                if erase:
                                    if full_chip:
                                        hub.send({"type": "flash", "stage": "擦除", "percent": 0,
                                                       "message": "正在整片擦除（Mass Erase）…"},
                                                      session_id=session_id)
                                        hw.jlink.erase()
                                        done.append('整片擦除')
                                    else:
                                        size = rend - rstart
                                        hub.send({"type": "flash", "stage": "擦除", "percent": 0,
                                                       "message": f"正在擦除区域 0x{rstart:08X}~0x{rend:08X}…"},
                                                      session_id=session_id)
                                        # 无按区域擦除的公开 API：以 0xFF 填充整块区域，
                                        # 经 flash loader 擦除扇区并编程，结果与擦除一致
                                        hw.jlink.flash(b'\xff' * size, rstart, on_progress=progress)
                                        done.append(f'区域擦除 0x{rstart:08X}~0x{rend:08X}')

                                # 2) 烧录
                                if program:
                                    if file_type == 'bin':
                                        if os.path.getsize(firmware_path) > (rend - rstart):
                                            raise RuntimeError(
                                                f"固件大小 {os.path.getsize(firmware_path)} 字节"
                                                f"超出区域容量 {rend - rstart} 字节")
                                        result = hw.jlink.flash_file(path=firmware_path, addr=rstart,
                                                                     on_progress=progress)
                                    else:
                                        # ELF/HEX/AXF：J-Link 解析文件内地址，addr 被忽略
                                        result = hw.jlink.flash_file(path=firmware_path, addr=0,
                                                                     on_progress=progress)
                                    done.append('烧录')

                                # 3) 收尾：烧录后自动复位让新固件直接运行；仅擦除不复位
                                if program:
                                    try:
                                        hw.jlink.reset(ms=10, halt=False)
                                        time.sleep(0.2)
                                        msg = '完成并已复位'
                                        log(f"{'、'.join(done)}完成并已复位 (返回值 {result})")
                                    except Exception as e:
                                        msg = f'完成（返回值 {result}），但复位失败: {e}'
                                        log(msg)
                                else:
                                    msg = '完成'
                                    log(f"{'、'.join(done)}{msg}")
                                break
                            except Exception as e:
                                last_err = e
                                log(f"闪存操作第 {attempt} 次尝试失败: {e}")
                        else:
                            raise last_err
                        hub.send({"type": "flash_done", "ok": True,
                                       "message": f"{'、'.join(done)}{msg}"},
                                      session_id=session_id)
                    finally:
                        # 恢复 RTT（无论擦除/烧录成败），与 connect 的启动顺序一致
                        if rtt_was_running:
                            try:
                                hw.jlink.swo_flush()
                                hw.jlink.rtt_start(None)
                                hw._rtt_started = True
                            except Exception:
                                pass
            except pylink.errors.JLinkException as e:
                hub.send({"type": "flash_done", "ok": False, "message": f"操作失败: {e}"},
                              session_id=session_id)
                log(f"操作失败: {e}")
            except Exception as e:
                hub.send({"type": "flash_done", "ok": False, "message": f"操作异常: {e}"},
                              session_id=session_id)
                log(f"操作异常: {e}")
            finally:
                with self.lock:
                    self.is_flashing = False

        threading.Thread(target=worker, daemon=True).start()
        return {"ok": True, "message": f"{ops}已开始"}


manager = JlinkManager()

# ============================================================
# Flask REST API
# ============================================================

app = Flask(__name__, static_folder=None)
app.config['MAX_CONTENT_LENGTH'] = 64 * 1024 * 1024  # 64MB 固件上限


@app.route('/')
def index():
    return send_from_directory(WEB_DIR, 'index.html')


@app.route('/web/<path:path>')
def web_static(path):
    return send_from_directory(WEB_DIR, path)


@app.route('/api/devices')
def api_devices():
    """返回型号数据（内置 JSON）+ J-Link 支持的设备数量。"""
    try:
        with open(MODELS_FILE, 'r', encoding='utf-8') as f:
            families = json.load(f)
    except Exception:
        families = {}
    supported = manager.get_supported_devices()
    return jsonify({
        "families": families,
        "jlink_devices": len(supported) if supported else None,
    })


@app.route('/api/status')
def api_status():
    return jsonify(manager.status())


@app.route('/api/config')
def api_config():
    """返回前端需要的运行时配置（如 WebSocket 端口）。"""
    return jsonify({"ws_port": WS_PORT, "http_port": WEB_PORT})


@app.route('/api/connect', methods=['POST'])
def api_connect():
    data = request.get_json(force=True, silent=True) or {}
    chip = data.get('chip', '')
    try:
        speed = int(data.get('speed', 4000))
        if speed <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "通讯速率格式错误"}), 400
    reset = bool(data.get('reset', True))
    session_id = data.get('session', None)
    if not chip:
        return jsonify({"ok": False, "error": "未选择芯片型号"}), 400
    result = manager.connect(chip, speed, reset, session_id=session_id)
    # 状态只推送给发起连接的会话
    hub.send({"type": "status", **manager.status()}, session_id=session_id)
    return jsonify(result)


@app.route('/api/disconnect', methods=['POST'])
def api_disconnect():
    data = request.get_json(force=True, silent=True) or {}
    session_id = data.get('session', None)
    if session_id is None:
        with manager.lock:
            session_id = manager.log_session
    result = manager.disconnect()
    hub.send({"type": "status", **manager.status()}, session_id=session_id)
    return jsonify(result)


@app.route('/api/reset', methods=['POST'])
def api_reset():
    return jsonify(manager.reset())


@app.route('/api/uplink', methods=['POST'])
def api_uplink():
    """把客户端输入写入设备 RTT 通道 0（上行）。"""
    data = request.get_json(force=True, silent=True) or {}
    text = data.get('data', '')
    if not text:
        return jsonify({"ok": False, "error": "内容为空"}), 400
    if manager.write(text.encode('utf-8', errors='replace')):
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "J-Link 未连接"}), 409


@app.route('/api/upload', methods=['POST'])
def api_upload():
    """上传固件到服务器临时目录，返回可用于烧录的路径。"""
    if 'file' not in request.files:
        return jsonify({"ok": False, "error": "未选择文件"}), 400
    f = request.files['file']
    if not f.filename:
        return jsonify({"ok": False, "error": "文件名无效"}), 400

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    # 用时间戳避免重名冲突
    safe_name = re.sub(r'[^\w.\-]', '_', os.path.basename(f.filename))
    path = os.path.join(UPLOAD_DIR, f"{int(time.time())}_{safe_name}")
    f.save(path)
    log(f"固件已上传: {path} ({os.path.getsize(path)} bytes)")
    return jsonify({"ok": True, "path": path, "name": f.filename})


@app.route('/api/flash', methods=['POST'])
def api_flash():
    data = request.get_json(force=True, silent=True) or {}
    path = data.get('path', '')
    session_id = data.get('session', None)

    erase = bool(data.get('erase', False))
    program = bool(data.get('program', True))
    if not erase and not program:
        return jsonify({"ok": False, "error": "请至少选择擦除或烧录操作"}), 400
    # 仅擦除不需要固件文件；烧录必须已上传
    if program and not path:
        return jsonify({"ok": False, "error": "未指定固件路径（请先上传）"}), 400

    # 固件类型：缺省/auto 时按扩展名推断
    file_type = str(data.get('file_type', 'auto')).lower()
    if file_type not in ALLOWED_FW_TYPES:
        ext = os.path.splitext(path)[1].lower().lstrip('.')
        file_type = ext if ext in ALLOWED_FW_TYPES else 'bin'
    if file_type not in ALLOWED_FW_TYPES:
        return jsonify({"ok": False, "error": "不支持的固件类型"}), 400

    # 区域：起始/结束地址（缺省视为全量整片）
    region = data.get('region') or {}
    try:
        rstart = _parse_addr(region.get('start', 0x08000000))
        rend = _parse_addr(region.get('end', rstart + 0x100000))
        if rstart < 0 or rend <= rstart:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "区域地址格式错误（应为十六进制，且起始 < 结束）"}), 400
    full_chip = bool(data.get('full_chip', False))

    # 区域擦除容量上限（0xFF 填充），全量整片擦除走原生 API 不受限
    if erase and not full_chip and (rend - rstart) > ERASE_FILL_MAX:
        return jsonify({"ok": False, "error": f"区域过大（> {ERASE_FILL_MAX // 0x100000}MB），"
                                              "请使用全量整片擦除或缩小区域"}), 400

    # BIN 固件按区域起始地址烧录，先校验容量是否足够
    if program and file_type == 'bin':
        if not os.path.exists(path):
            return jsonify({"ok": False, "error": "固件文件不存在"}), 400
        fsize = os.path.getsize(path)
        if fsize > (rend - rstart):
            return jsonify({"ok": False, "error": f"固件大小 {fsize} 字节超出区域容量 "
                                                  f"{rend - rstart} 字节（0x{rstart:08X}~0x{rend:08X}）"}), 400

    region = {"name": region.get('name', '全量整片'), "start": rstart, "end": rend}
    return jsonify(manager.flash(path, file_type, erase=erase, program=program,
                                 region=region, full_chip=full_chip, session_id=session_id))


# ============================================================
# WebSocket 服务器（独立线程 + asyncio 事件循环）
# ============================================================

async def ws_handler(ws):
    # 连接先不绑定会话，等客户端 hello 消息声明 session_id 后再绑定
    session_id = None
    try:
        async for message in ws:
            try:
                msg = json.loads(message)
            except Exception as e:
                log("WebSocket 消息解析失败: %s" % e)
                continue
            mtype = msg.get('type')
            if mtype == 'hello':
                session_id = msg.get('session') or None
                hub.attach(ws, session_id)
                # 绑定后推送当前状态给该会话
                try:
                    await ws.send(json.dumps(
                        {"type": "status", **manager.status()}, ensure_ascii=False))
                except Exception as e:
                    log("WebSocket 状态推送失败: %s" % e)
            elif mtype == 'ping':
                try:
                    await ws.send(json.dumps({"type": "pong"}))
                except Exception as e:
                    log("WebSocket pong 发送失败: %s" % e)
    except Exception as e:
        log("WebSocket 连接异常: %s" % e)
    finally:
        # 若该会话是当前日志会话（浏览器关闭/刷新），自动断开释放 J-Link，
        # 避免 J-Link 一直被占用且日志无人接收
        with manager.lock:
            is_owner = session_id is not None and manager.log_session == session_id
        if is_owner:
            manager.disconnect()
        hub.detach(ws)


def ws_server_thread(host, port):
    async def main():
        async with websockets.serve(ws_handler, host, port, max_size=1024 * 1024):
            hub.set_loop(asyncio.get_running_loop())
            log(f"WebSocket 服务器监听 {host}:{port}")
            await asyncio.Future()  # 永久运行

    try:
        asyncio.run(main())
    except Exception as e:
        log("WebSocket 服务器退出: %s" % e)


# ============================================================
# 入口
# ============================================================

def main():
    global WEB_HOST, WEB_PORT, WS_PORT

    parser = argparse.ArgumentParser(description="STM32 J-Link 网页调试控制台")
    parser.add_argument('--host', default=WEB_HOST, help='监听地址 (默认 %s)' % WEB_HOST)
    parser.add_argument('--port', type=int, default=WEB_PORT, help='HTTP 端口 (默认 %d)' % WEB_PORT)
    parser.add_argument('--ws-port', type=int, default=WS_PORT, help='WebSocket 端口 (默认 %d)' % WS_PORT)
    args = parser.parse_args()
    WEB_HOST, WEB_PORT, WS_PORT = args.host, args.port, args.ws_port

    os.makedirs(UPLOAD_DIR, exist_ok=True)

    log("=" * 56)
    log(" STM32 J-Link 网页调试控制台")
    log("=" * 56)
    log("HTTP  : http://%s:%d" % (WEB_HOST, WEB_PORT))
    log("WS    : ws://%s:%d" % (WEB_HOST, WS_PORT))

    # 预取一次设备列表（确认 J-Link DLL 可用）
    supported = manager.get_supported_devices()
    if supported:
        stm = [d for d in supported if 'STM32' in d.upper()]
        log(f"J-Link 支持设备: {len(supported)} 个（其中 STM32 {len(stm)} 个）")
    else:
        log("警告: 无法读取 J-Link 设备列表（使用内置型号数据），"
            "若报 'Expected to be given a valid DLL' 请设置 JLINK_LIB")

    threading.Thread(target=ws_server_thread, args=(WEB_HOST, WS_PORT), daemon=True).start()
    # Flask 开发服务器（单用户工具够用）
    app.run(host=WEB_HOST, port=WEB_PORT, threaded=True, debug=False)


if __name__ == '__main__':
    main()
