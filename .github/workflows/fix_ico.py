import struct, zlib

def make_png_32bit(size, fg=(196,133,90), bg=(20,16,11)):
    def chunk(name, data):
        crc = zlib.crc32(name + data) & 0xffffffff
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', crc)
    
    ihdr_data = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    
    raw = b''
    cx, cy = size // 2, size // 2
    r2 = (size // 2 - 1) ** 2
    for y in range(size):
        raw += b'\x00'
        for x in range(size):
            if (x-cx)**2 + (y-cy)**2 < r2:
                raw += bytes([fg[0], fg[1], fg[2]])
            else:
                raw += bytes([bg[0], bg[1], bg[2]])
    
    compressed = zlib.compress(raw, 9)
    
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', ihdr_data)
    png += chunk(b'IDAT', compressed)
    png += chunk(b'IEND', b'')
    return png

sizes = [16, 32, 48, 64, 128, 256]
images = [make_png_32bit(s) for s in sizes]

n = len(images)
header = struct.pack('<HHH', 0, 1, n)
data_offset = 6 + n * 16
entries = b''
for i, (s, img) in enumerate(zip(sizes, images)):
    w = s if s < 256 else 0
    h = s if s < 256 else 0
    entries += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 24, len(img), data_offset)
    data_offset += len(img)

with open('src-tauri/icons/icon.ico', 'wb') as f:
    f.write(header + entries + b''.join(images))

print('ICO written successfully')
