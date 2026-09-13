"""检查 PNG 指定像素的 RGBA（标准库实现，无第三方依赖）"""
import zlib, struct, sys

def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
    pos = 8
    width = height = bitdepth = colortype = None
    idat = b''
    while pos < len(data):
        (length,) = struct.unpack('>I', data[pos:pos+4])
        ctype = data[pos+4:pos+8]
        chunk = data[pos+8:pos+8+length]
        if ctype == b'IHDR':
            width, height, bitdepth, colortype = struct.unpack('>IIBB', chunk[:10])
        elif ctype == b'IDAT':
            idat += chunk
        elif ctype == b'IEND':
            break
        pos += 12 + length
    raw = zlib.decompress(idat)
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colortype]
    stride = width * channels
    # 反滤波
    out = bytearray()
    prev = bytearray(stride)
    i = 0
    for _ in range(height):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i+stride]); i += stride
        if f == 1:
            for x in range(channels, stride):
                line[x] = (line[x] + line[x-channels]) & 0xFF
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif f == 3:
            for x in range(stride):
                a = line[x-channels] if x >= channels else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 0xFF
        elif f == 4:
            for x in range(stride):
                a = line[x-channels] if x >= channels else 0
                b = prev[x]
                c = prev[x-channels] if x >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 0xFF
        out += line
        prev = line
    return width, height, channels, bytes(out)

def px(w, h, ch, buf, x, y):
    off = (y * w + x) * ch
    v = buf[off:off+ch]
    return tuple(v) + (255,) if ch == 3 else tuple(v)

path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/balancedeck-shots/1-corner.png'
w, h, ch, buf = read_png(path)
print(f'{path}: {w}x{h}, channels={ch}')
print('采样点 (x,y) → RGBA：')
for (x, y, label) in [
    (2, 2, '左上角极外'),
    (12, 12, '圆角弧外'),
    (30, 30, '卡片内'),
    (w - 3, 2, '右上角极外'),
    (w - 3, h - 3, '右下角极外'),
    (2, h - 3, '左下角极外'),
]:
    if 0 <= x < w and 0 <= y < h:
        print(f'  {label:10s} ({x:3d},{y:3d}) → {px(w, h, ch, buf, x, y)}')
