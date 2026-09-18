[中文](./README.md) | **English**

# JLinkHub

[![Python 3.9+](https://img.shields.io/badge/Python-3.9+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform: Linux](https://img.shields.io/badge/Platform-Linux-lightgrey.svg)]()

A web-based STM32 debugging tool powered by SEGGER J-Link. Select chips, view RTT logs, and flash firmware — all from your browser, no desktop client required.

![JLinkHub Main Interface](assets/screenshot-main.png)

## Features

| Feature | Description |
|---------|-------------|
| **Chip Selection** | 18 series × 98 mainstream models with cascading dropdowns and fuzzy search (type `F103`, `C8`, or `ZET6` to filter); displays Flash/RAM capacity |
| **RTT Logging** | Real-time colored output; BDSCOL color tags render true-color; INFO/WARNING/ERROR auto-coloring; timestamp, pause, clear, and save support |
| **Firmware Flashing** | Select local firmware (.elf/.hex/.bin/.axf) in browser; independent **flash / erase** operations or combined; custom flash regions (e.g. Bootloader / APP partitions); auto-parse address ranges from ELF/HEX; real-time progress bar; auto-reset after flash |
| **Uplink Commands** | Send commands to device RTT channel 0 |
| **Session Isolation** | Logs are pushed only to the connecting browser; multiple users can share one probe |
| **Auto Reconnect** | Automatically reconnects when J-Link is unplugged or target resets |

## Quick Start

### Prerequisites

- Python 3.9+
- [SEGGER J-Link Software](https://www.segger.com/downloads/jlink/) (including `libjlinkarm.so`)
- J-Link probe connected to target board via USB

### Installation

```bash
# Clone the repository
git clone https://github.com/yourname/jlink-web-console.git
cd jlink-web-console

# One-click setup (creates venv + installs dependencies)
./setup.sh

# Run
source .venv/bin/activate
python3 web_console.py
```

Open **http://127.0.0.1:8080** in your browser. For LAN access, use `http://<server-ip>:8080`.

> **Manual install** (without setup.sh): `pip install pylink-square flask websockets`

### J-Link Software Installation

```bash
# Ubuntu/Debian (arm64)
wget https://www.segger.com/downloads/jlink/JLink_Linux_V818_arm64.deb
sudo dpkg -i JLink_Linux_V818_arm64.deb

# pylink automatically searches /opt/SEGGER for libjlinkarm.so
# If installed elsewhere, specify at startup: JLINK_LIB=/path/to/libjlinkarm.so python3 web_console.py
```

## Usage Guide

### 1. Select Chip and Connect

Choose chip series → specific model in the left panel, set communication speed and reset mode, then click **Connect**.

The chip dropdown supports fuzzy search: type `F1` to filter all F1 series, type `C8` to locate the C8T6 model precisely.

### 2. View RTT Logs

After connecting, RTT logs from the device are displayed in real time in the main area.

**Color rules**:
- Device sends `BDSCOL(<decimal RGB>)` tags (e.g. `BDSCOL(16711680)` = red) → rendered in that color
- Plain text lines without color tags are auto-colored by prefix:

  | Prefix | Color |
  |--------|-------|
  | `INFO` / `I` / `[INFO]` / `[I]` | Green |
  | `WARNING` / `W` / `[WARNING]` / `[W]` | Yellow |
  | `ERROR` / `E` / `[ERROR]` / `[E]` | Red |

**Sending colored logs from device** (C code):

```c
// Define color macros
#define LOG_RED(fmt, ...)   printf("BDSCOL(16711680)" fmt "\r\n", ##__VA_ARGS__)
#define LOG_GREEN(fmt, ...) printf("BDSCOL(65280)" fmt "\r\n", ##__VA_ARGS__)

// Usage
LOG_RED("Sensor failed!");
LOG_GREEN("Boot OK, version %s", VERSION);
```

### 3. Flash Firmware

The firmware panel at the bottom supports file selection, operation and region configuration. Click execute to start; progress bar shows Erase → Flash → Verify stages in real time. MCU auto-resets after successful flash.

**Firmware Type**: Auto-detected by file extension (can also be switched manually). Different types are flashed differently:

| Type | Flash Method |
|------|-------------|
| `HEX` / `ELF` / `AXF` | J-Link flashes using embedded addresses directly; selecting the file auto-parses the address range and generates a "Firmware Region" option (usable for erase) |
| `BIN` | No embedded addresses; flashed at the **start address** of the selected region; firmware size must not exceed region capacity |

**Operation Selection**: `Flash` / `Erase` checkboxes can be used independently or together. When both are checked, **erase runs first then flash** for a clean start.

**Flash Region**: Built-in "Full Chip" preset (starts at `0x08000000`, end address auto-updates based on selected chip's Flash capacity, e.g. F103ZET6 → 512KB). Click **＋ Add Region** to create custom partitions, e.g. for OTA Bootloader / App:

```
Name: Bootloader    0x08000000 ~ 0x0800FFFF   (64 KB)
Name: App           0x08010000 ~ 0x0807FFFF   (448 KB)
```

"Full Chip" erase uses J-Link native Mass Erase (faster); custom region erase uses flash loader to fill `0xFF` (equivalent to erase). Custom regions are saved in browser localStorage and persist across sessions.

![Firmware Flash Progress](assets/screenshot-flash.png)

### 4. Uplink Commands

The input box below the log area sends commands to device RTT channel 0 (press Enter to send).

## Command-Line Arguments

| Argument | Environment Variable | Default | Description |
|----------|---------------------|---------|-------------|
| `--host` | `WEB_HOST` | `0.0.0.0` | Listen address |
| `--port` | `WEB_PORT` | `8080` | HTTP port |
| `--ws-port` | `WS_PORT` | `8765` | WebSocket port |
| | `JLINK_LIB` | empty | Path to `libjlinkarm.so` |

## Project Structure

```
├── setup.sh              # Environment setup script
├── web_console.py        # Backend: Flask + WebSocket + J-Link management
├── web/                  # Frontend (pure HTML/CSS/JS, no external CDN)
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── stm32_models.json # Built-in 18 series, 98 model data
└── rtt_lib/              # RTT communication library
    ├── jlink.py          # J-Link RTT driver (pylink)
    └── hardware.py       # Device base class
```

## API Reference

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Query connection status (chip model, Flash/RAM capacity, probe SN) |
| `POST` | `/api/connect` | Connect to target; params: `chip`, `speed`, `reset_mode` |
| `POST` | `/api/disconnect` | Disconnect |
| `POST` | `/api/reset` | Reset MCU |
| `POST` | `/api/write` | Write memory; params: `addr`, `data` (hex string) |
| `POST` | `/api/upload` | Upload firmware (multipart); returns `path` |
| `POST` | `/api/flash` | Erase/flash; params: `path`, `file_type`, `erase`, `program`, `region`, `full_chip` |

### WebSocket

Connect to `ws://<host>:<ws-port>` for real-time push:

| Message Type | Description |
|-------------|-------------|
| `rtt_log` | RTT log line, with `text` and `color` fields |
| `flash` | Flash progress, with `stage`, `percent`, `message` |
| `flash_done` | Flash complete, with `ok`, `message` |
| `connected` / `disconnected` | Connection state change |

## Architecture

```
Browser (Single Page App)
  │ WebSocket: RTT logs / flash progress / status push
  │ REST API: connect / disconnect / reset / flash / upload
  ▼
web_console.py (Python)
  ├─ Flask: static pages + REST API
  ├─ websockets: WebSocket real-time push
  ├─ JlinkManager: J-Link connection lifecycle management
  │   └─ dll_lock: serializes all J-Link DLL calls (DLL is not thread-safe)
  └─ pylink → libjlinkarm.so
                    │
              J-Link Probe ──SWD── Target Board
```

> **Thread Safety**: The J-Link DLL (`libjlinkarm.so`) is not thread-safe. RTT reader and flash/erase worker threads must not call the DLL concurrently. This project uses a `dll_lock` mutex to serialize all DLL calls (RTT read, connect, erase, flash, reset), preventing segmentation faults.

## FAQ

### `Expected to be given a valid DLL`

pylink cannot find the J-Link shared library. Ensure [SEGGER J-Link Software](https://www.segger.com/downloads/jlink/) is installed, or use `JLINK_LIB` to specify the path.

### Connected but no logs

RTT control block not auto-discovered. Try:
1. Confirm SEGGER RTT is enabled in firmware (`SEGGER_RTT_Init()` called)
2. Check `_SEGGER_RTT` address in map file and set environment variables:
   ```bash
   RTT_SEARCH_START=0x20000000 RTT_SEARCH_RANGE=0x64 python3 web_console.py
   ```

### Chinese garbled text

Default format is `asc`. If device outputs UTF-8 Chinese, change `char_format='utf-8'` in `web_console.py`.

### Multiple J-Link Probes

First available probe is selected automatically. To specify one, set `SERIAL_NO=<serial>` at startup (serial number available in SEGGER J-Link Configurator).

### macOS / Windows Support

Primarily developed and tested on Linux. Should also work on macOS (pylink supports it). Windows requires additional path configuration. Contributions for cross-platform improvements are welcome.

## Contributing

Issues and Pull Requests are welcome!

1. Fork this repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit changes: `git commit -m 'Add my feature'`
4. Push branch: `git push origin feature/my-feature`
5. Submit a Pull Request

## Acknowledgements

- [SEGGER J-Link](https://www.segger.com/products/debug-probes/j-link/) — Hardware debug probe and software toolchain
- [pylink-square](https://github.com/square/pylink) — Python bindings for J-Link
- [Flask](https://flask.palletsprojects.com/) — Web framework
- [websockets](https://websockets.readthedocs.io/) — WebSocket library

## License

[MIT](LICENSE) © [Your Name]
