"""Static file server for html/js/css (see README.md) - a drop-in
replacement for `python3 -m http.server`, adding HTTP Range support
(206 Partial Content), which the standard library's http.server lacks
entirely - verified live with a curl Range request: it always returns a
full 200 response, never Accept-Ranges/206/Content-Range.

Range support matters here because recorded/uploaded video and audio
(webcam footage, narration, "Your Media" clips - all served from
premiere_exports/, under this same root - see backend/premiere_bridge.py)
get played back through plain <video>/<audio> tags (see
js/paper-extract.js). Safari in particular can refuse to play a clip at
all without a proper Range response, not just when seeking; Chrome/Firefox
are more lenient but still benefit from it.

Usage: python3 serve.py [port]   (default 5500, matching README.md - run
from the repo root, same requirement as the plain http.server command it
replaces, since paths are root-absolute - e.g. /js/helpers.js).
"""
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class _BoundedReader:
    """Wraps an open file so copyfile() (see BaseHTTPRequestHandler.do_GET,
    which reads from whatever send_head() below returns) only ever reads
    exactly `length` bytes from wherever the file was seeked to - the
    file's true EOF may be well past the requested range's end, so a plain
    file object alone would over-read."""

    def __init__(self, f, length):
        self._f = f
        self._remaining = length

    def read(self, size=-1):
        if self._remaining <= 0:
            return b''
        if size < 0 or size > self._remaining:
            size = self._remaining
        chunk = self._f.read(size)
        self._remaining -= len(chunk)
        return chunk

    def close(self):
        self._f.close()


class RangeRequestHandler(SimpleHTTPRequestHandler):
    """Only regular files get Range treatment here - directory listings
    (nothing to seek within) fall through to the base implementation
    unchanged, which already handles translate_path's query-string
    stripping, directory-index resolution, and 404s correctly."""

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()

        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(404, 'File not found')
            return None

        try:
            file_size = os.fstat(f.fileno()).st_size
        except OSError:
            f.close()
            self.send_error(500, 'Could not stat file')
            return None

        start, end, status = 0, file_size - 1, 200
        range_header = self.headers.get('Range')
        if range_header:
            parsed = self._parse_range(range_header, file_size)
            if parsed is None:
                f.close()
                self.send_response(416, 'Requested Range Not Satisfiable')
                self.send_header('Content-Range', f'bytes */{file_size}')
                self.end_headers()
                return None
            start, end = parsed
            status = 206

        length = end - start + 1
        self.send_response(status)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.end_headers()

        f.seek(start)
        return _BoundedReader(f, length)

    @staticmethod
    def _parse_range(range_header, file_size):
        """Handles the 3 forms a Range header can take: "bytes=start-end",
        "bytes=start-" (through the end of the file), and "bytes=-suffix"
        (the last N bytes - what a browser typically sends first, to probe
        whether Range is supported at all, before seeking to a real
        offset). Returns (start, end) inclusive, or None if the header is
        malformed/unsatisfiable. Multi-range requests ("bytes=0-10,20-30")
        aren't supported - a dev server never needs to serve more than one
        contiguous slice per request."""
        if not range_header.startswith('bytes=') or ',' in range_header:
            return None
        spec = range_header[len('bytes='):]
        if '-' not in spec:
            return None
        start_str, end_str = spec.split('-', 1)
        try:
            if start_str == '':
                suffix = int(end_str)
                if suffix <= 0:
                    return None
                start = max(0, file_size - suffix)
                end = file_size - 1
            else:
                start = int(start_str)
                end = int(end_str) if end_str else file_size - 1
        except ValueError:
            return None
        if file_size == 0 or start > end or start >= file_size:
            return None
        return start, min(end, file_size - 1)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
    server = HTTPServer(('', port), RangeRequestHandler)
    print(f'Serving {os.getcwd()} on http://localhost:{port} (HTTP Range requests supported)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
