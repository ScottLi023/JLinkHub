"""J-Link RTT 通信驱动 — 通过 pylink 连接 J-Link，读写 RTT 通道 0。"""

import pylink
from hardware import DeviceBase


class JlinkRTT(DeviceBase):
    """J-Link RTT 通信驱动。

    继承 DeviceBase，通过 pylink 连接 J-Link 探针，读写目标设备的 RTT 通道 0。
    支持 SWD 接口、可选复位、_SEGGER_RTT 地址搜索、多种字符格式。

    Attributes:
        jlink: 底层 pylink.JLink 对象（用于 reset、flash_file 等高级操作）
        chip: 目标芯片型号
        speed: SWD 速率（kHz）
    """

    def __init__(self, err_cb, warn_cb, chip: str = 'STM32F103ZET6', speed: int = 4000,
                 read_size: int = 8192, interval: float = 0.002, char_format: str = 'asc'):
        super().__init__(err_cb, warn_cb, interval=interval, char_format=char_format)
        self.jlink = pylink.JLink()
        self.chip = chip
        self.speed = speed
        self._read_size = read_size
        self._buf_index = 0
        self._rtt_started = False
        self._partial = b''        # utf-8 / gb2312 部分字节缓冲
        self._empty_count = 0
        self._last_sn = None       # 上次成功连接的探针序列号

    def open(self, speed: int = 0, chip: str = '', reset: bool = True,
             start_address: int | None = None, range_size: int = 0,
             sn: str | None = None) -> bool:
        """连接 J-Link 并启动 RTT。成功返回 True。

        Args:
            speed: SWD 速率（kHz），0 表示使用默认值
            chip: 目标芯片型号，空字符串表示使用默认值
            reset: 连接后是否复位目标
            start_address: _SEGGER_RTT 搜索起始地址，None 表示自动搜索
            range_size: 搜索范围（字节数），0 表示自动
            sn: 指定探针序列号，None 表示自动选择
        """
        try:
            self.reset_state()
            if speed:
                self.speed = speed
            if chip:
                self.chip = chip

            # 优先使用上次成功连接的序列号
            if sn is None and self._last_sn is not None:
                try:
                    self.jlink.open(serial_no=self._last_sn)
                except pylink.errors.JLinkException:
                    self.jlink.open()
            else:
                self.jlink.open(serial_no=sn)

            self.jlink.set_tif(pylink.enums.JLinkInterfaces.SWD)
            self.jlink.set_speed(self.speed)
            self.jlink.connect(self.chip)

            if reset:
                self.jlink.reset(ms=10, halt=False)

            # 搜索 _SEGGER_RTT 控制块地址
            addr = self._find_rtt(start_address, range_size)

            if self.jlink.connected():
                self.jlink.swo_flush()
                self.jlink.rtt_start(addr)
                self._rtt_started = True
                self._last_sn = self.jlink.serial_number
                return True

        except pylink.errors.JLinkException as e:
            self.err_cb(f"J-Link 连接失败: {e}")
        return False

    def close(self):
        """关闭 RTT 并断开 J-Link。"""
        if self.jlink.opened():
            self._rtt_started = False
            try:
                self.jlink.rtt_stop()
            except Exception:
                pass
            self.jlink.close()

    def is_open(self) -> bool:
        """J-Link 是否已连接。"""
        return self.jlink.opened()

    @property
    def serial_number(self) -> int:
        """当前连接的探针序列号（未连接返回 0）。"""
        return self.jlink.serial_number if self.jlink.opened() else 0

    def write(self, data: list):
        """向 RTT 通道 0 写入数据。"""
        self.jlink.rtt_write(0, data)

    def read(self):
        """从 RTT 通道 0 读取数据并入队列（被上层轮询调用）。"""
        if not self._rtt_started:
            return
        try:
            raw = self.jlink.rtt_read(self._buf_index, self._read_size)
            if self.char_format == 'asc':
                text = ''.join(chr(b) for b in raw)
                self._handle_data(text)
            elif self.char_format in ('utf-8', 'gb2312'):
                self._partial += bytes(raw)
                if raw:
                    self._empty_count = int(6 / (self.interval * 1000))
                elif self._empty_count > 0:
                    self._empty_count -= 1
                if self._empty_count == 0 and self._partial:
                    decoded = self._partial.decode(self.char_format, errors='ignore')
                    decoded = decoded.replace('\\n', '\n')
                    self._handle_data(decoded)
                    self._partial = b''
        except Exception as e:
            self.err_cb(f"RTT 读取失败: {e}")

    def _find_rtt(self, start_address: int | None, range_size: int) -> int | None:
        """在指定范围内搜索 "SEGGER RTT" 字符串，返回实际控制块地址。

        搜索成功返回修正后的地址，失败返回 start_address（交给 J-Link 自动搜索）。
        """
        if start_address is None or range_size <= 0:
            return start_address
        try:
            words = self.jlink.memory_read32(start_address, range_size // 4)
            data = b''.join(w.to_bytes(4, 'little') for w in words)
            idx = data.find(b'SEGGER RTT')
            if idx >= 0:
                return start_address + idx
        except Exception:
            pass
        return start_address
