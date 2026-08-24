#!/usr/bin/env python3
"""
Audio Tutor PWA - 本地開發伺服器 (server.py)
功能：
1. 監聽 Port 8080
2. 支援 SPA 路由（非檔案路徑自動回退至 index.html）
3. 確保正確的 MIME 類型（尤其是 .mjs -> application/javascript）
4. 設定 CORS 標頭與禁用快取 (Cache-Control: no-cache)
"""

import http.server
import json
import mimetypes
import os
import re
import socket
import ssl
import sys
import time
import urllib.parse
import urllib.request
import uuid

PORT = 8090
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

# 確保 MIME 類型對應正確
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("text/html", ".html")
mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("audio/mpeg", ".mp3")
mimetypes.add_type("audio/wav", ".wav")


def synthesize_edge_tts(text: str, voice: str = "zh-TW-HsiaoChenNeural", rate: str = "+0%") -> bytes:
    """
    使用純 Python 標準庫 (socket + ssl) 透過 WebSocket 連接 Microsoft Edge TTS 伺服器
    將文字合成為高品質神經網路 MP3 音訊 (24kHz Mono MP3)
    """
    conn_id = uuid.uuid4().hex
    req_id = uuid.uuid4().hex
    host = "speech.platform.bing.com"
    port = 443
    path = f"/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EA651143B48DA8F676841211&ConnectionId={conn_id}"

    # WebSocket 握手金鑰
    ws_key = "dGhlIHNhbXBsZSBub25jZQ=="

    handshake_headers = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {ws_key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n"
        f"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0\r\n"
        f"Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold\r\n\r\n"
    )

    ctx = ssl.create_default_context()
    sock = socket.create_connection((host, port), timeout=15)
    ssock = ctx.wrap_socket(sock, server_hostname=host)
    ssock.sendall(handshake_headers.encode("utf-8"))

    # 讀取握手回應
    resp_buf = b""
    while b"\r\n\r\n" not in resp_buf:
        chunk = ssock.recv(1024)
        if not chunk:
            break
        resp_buf += chunk

    if b"101 Switching Protocols" not in resp_buf:
        ssock.close()
        raise RuntimeError(f"Edge TTS WebSocket 握手失敗: {resp_buf[:200].decode('utf-8', errors='ignore')}")

    def send_ws_text(payload: str):
        data = payload.encode("utf-8")
        frame = bytearray()
        frame.append(0x81)  # FIN + Text frame
        length = len(data)
        mask_key = os.urandom(4)
        if length <= 125:
            frame.append(0x80 | length)
        elif length <= 65535:
            frame.append(0x80 | 126)
            frame.extend(length.to_bytes(2, "big"))
        else:
            frame.append(0x80 | 127)
            frame.extend(length.to_bytes(8, "big"))
        frame.extend(mask_key)
        masked_data = bytearray(b ^ mask_key[i % 4] for i, b in enumerate(data))
        frame.extend(masked_data)
        ssock.sendall(frame)

    # 1. 發送語音配置
    config_msg = (
        "Content-Type:application/json;charset=utf-8\r\n"
        "Path:speech.config\r\n\r\n"
        '{"context":{"synthesis":{"audio":{"metadataoptions":'
        '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},'
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'
    )
    send_ws_text(config_msg)

    # 2. 發送 SSML 朗讀請求
    clean_text = (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )
    date_str = time.strftime("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)", time.gmtime())
    ssml_msg = (
        f"X-RequestId:{req_id}\r\n"
        f"Content-Type:application/ssml+xml\r\n"
        f"X-Timestamp:{date_str}\r\n"
        "Path:ssml\r\n\r\n"
        f"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-TW'>"
        f"<voice name='{voice}'><prosody pitch='+0Hz' rate='{rate}'>{clean_text}</prosody></voice>"
        f"</speak>"
    )
    send_ws_text(ssml_msg)

    # 3. 讀取 WebSocket 回應直到 turn.end
    audio_chunks = []
    recv_buf = bytearray()

    while True:
        chunk = ssock.recv(8192)
        if not chunk:
            break
        recv_buf.extend(chunk)

        while len(recv_buf) >= 2:
            b1 = recv_buf[0]
            b2 = recv_buf[1]
            opcode = b1 & 0x0F
            is_masked = bool(b2 & 0x80)
            payload_len = b2 & 0x7F
            hdr_len = 2

            if payload_len == 126:
                if len(recv_buf) < 4:
                    break
                payload_len = int.from_bytes(recv_buf[2:4], "big")
                hdr_len = 4
            elif payload_len == 127:
                if len(recv_buf) < 10:
                    break
                payload_len = int.from_bytes(recv_buf[2:10], "big")
                hdr_len = 10

            if is_masked:
                hdr_len += 4

            total_frame_len = hdr_len + payload_len
            if len(recv_buf) < total_frame_len:
                break  # 等待更多資料

            payload = recv_buf[hdr_len:total_frame_len]
            recv_buf = recv_buf[total_frame_len:]

            if opcode == 0x01:  # Text frame
                text_content = payload.decode("utf-8", errors="ignore")
                if "Path:turn.end" in text_content:
                    ssock.close()
                    return b"".join(audio_chunks)
            elif opcode == 0x02:  # Binary frame
                if len(payload) >= 2:
                    header_len = int.from_bytes(payload[0:2], "big")
                    if len(payload) >= 2 + header_len:
                        header_text = payload[2 : 2 + header_len].decode("utf-8", errors="ignore")
                        if "Path:audio" in header_text:
                            audio_data = bytes(payload[2 + header_len :])
                            if audio_data:
                                audio_chunks.append(audio_data)

    ssock.close()
    return b"".join(audio_chunks)


class SpaRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def end_headers(self):
        # 設置 CORS 標頭
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD")
        self.send_header("Access-Control-Allow-Headers", "*")

        # 開發環境下停用快取
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")

        super().end_headers()

    def do_OPTIONS(self):
        # 處理 CORS 預檢請求
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        parsed_url = urllib.parse.urlparse(self.path)
        parsed_path = parsed_url.path

        if parsed_path == "/api/tts":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body.decode("utf-8")) if body else {}
                text = data.get("text", "")
                voice = data.get("voice", "zh-TW-HsiaoChenNeural")
                rate = data.get("rate", "+0%")

                if not text:
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error": "Missing text parameter"}')
                    return

                audio_bytes = synthesize_edge_tts(text, voice, rate)
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(audio_bytes)))
                self.end_headers()
                self.wfile.write(audio_bytes)
                return
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                err_msg = json.dumps({"error": f"TTS synthesis failed: {str(e)}"})
                self.wfile.write(err_msg.encode("utf-8"))
                return

        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        # 解析路徑與 query 參數
        parsed_url = urllib.parse.urlparse(self.path)
        parsed_path = parsed_url.path

        # 處理 /api/tts GET 請求
        if parsed_path == "/api/tts":
            query_params = urllib.parse.parse_qs(parsed_url.query)
            text = query_params.get("text", [None])[0]
            voice = query_params.get("voice", ["zh-TW-HsiaoChenNeural"])[0]
            rate = query_params.get("rate", ["+0%"])[0]

            if not text:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error": "Missing text parameter"}')
                return

            try:
                audio_bytes = synthesize_edge_tts(text, voice, rate)
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(audio_bytes)))
                self.end_headers()
                self.wfile.write(audio_bytes)
                return
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                err_msg = json.dumps({"error": f"TTS synthesis failed: {str(e)}"})
                self.wfile.write(err_msg.encode("utf-8"))
                return

        # 處理 /api/proxy 代理遠端 Podcast RSS / 音訊請求，消除 CORS 限制
        if parsed_path == "/api/proxy":
            query_params = urllib.parse.parse_qs(parsed_url.query)
            target_url = query_params.get("url", [None])[0]
            if not target_url:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error": "Missing url parameter"}')
                return

            try:
                # 建立對外請求
                req = urllib.request.Request(
                    target_url,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        "Accept": "*/*",
                    },
                )
                with urllib.request.urlopen(req, timeout=30) as response:
                    content_type = response.headers.get("Content-Type", "application/octet-stream")
                    content_length = response.headers.get("Content-Length")

                    self.send_response(response.status)
                    self.send_header("Content-Type", content_type)
                    if content_length:
                        self.send_header("Content-Length", content_length)
                    self.end_headers()

                    # 串流傳輸回應數據
                    while True:
                        chunk = response.read(64 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                return
            except Exception as e:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                err_msg = f'{{"error": "Proxy request failed: {str(e)}"}}'
                self.wfile.write(err_msg.encode("utf-8"))
                return

        local_path = self.translate_path(parsed_path)

        # 若檔案或目錄不存在，且不是嘗試訪問特定靜態副檔名，則回退至 index.html (SPA Routing)
        if not os.path.exists(local_path):
            index_path = os.path.join(ROOT_DIR, "index.html")
            if os.path.exists(index_path):
                self.path = "/index.html"

        return super().do_GET()

    def guess_type(self, path):
        # 覆寫 MIME 類型判斷
        ctype, encoding = mimetypes.guess_type(path)
        if path.endswith(".mjs"):
            return "application/javascript"
        return ctype or "application/octet-stream"

    def log_message(self, format, *args):
        # 格式化輸出日誌
        sys.stdout.write(f"[{self.log_date_time_string()}] {format % args}\n")
        sys.stdout.flush()


def run_server():
    server_address = ("", PORT)
    httpd = http.server.ThreadingHTTPServer(server_address, SpaRequestHandler)
    print("=" * 60)
    print("🎧 Audio Tutor PWA 開發伺服器已啟動")
    print(f"🚀 本地網址: http://localhost:{PORT}")
    print(f"📁 根目錄  : {ROOT_DIR}")
    print(f"✨ 支援 Edge-TTS 神經語音代理: /api/tts")
    print("🛑 按 Ctrl+C 可停止伺服器")
    print("=" * 60)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n伺服器已停止。")
        httpd.server_close()


if __name__ == "__main__":
    run_server()
