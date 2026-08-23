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
import mimetypes
import os
import sys
import urllib.parse
import urllib.request

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

    def do_GET(self):
        # 解析路徑與 query 參數
        parsed_url = urllib.parse.urlparse(self.path)
        parsed_path = parsed_url.path
        
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
                        "Accept": "*/*"
                    }
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
    print("🛑 按 Ctrl+C 可停止伺服器")
    print("=" * 60)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n伺服器已停止。")
        httpd.server_close()


if __name__ == "__main__":
    run_server()
