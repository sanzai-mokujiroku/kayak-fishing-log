#!/usr/bin/env python3
"""釣行記録アプリのアイコンを生成（外部ライブラリ不要）。海色の背景にメタルジグを描く。"""
import zlib, struct, math

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def make_pixels(S):
    top    = (0x3a, 0x74, 0xa8)   # 明るい海色
    bottom = (0x14, 0x36, 0x55)   # 深い海色
    wave1  = (0xff, 0xff, 0xff)
    wave2  = (0xbf, 0xe3, 0xf7)
    jig_lo = (0x9a, 0xa7, 0xb4)   # ジグ(シルバー) 影
    jig_hi = (0xf2, 0xf6, 0xfa)   # ジグ ハイライト
    hook   = (0x33, 0x3a, 0x40)   # フック
    px = bytearray()
    for y in range(S):
        row = bytearray()
        row.append(0)  # PNG filter type 0
        for x in range(S):
            t = y / S
            r, g, b = lerp(top, bottom, t)
            a = 255
            # 波のバンド
            w_a = 0.05 * S * math.sin(x / (S * 0.11)) + 0.24 * S
            w_b = 0.045 * S * math.sin(x / (S * 0.095) + 1.7) + 0.72 * S
            if abs(y - w_a) < S * 0.014:
                r, g, b = wave2
            if abs(y - w_b) < S * 0.012:
                r, g, b = lerp((r, g, b), wave1, 0.8)
            # 斜めに構えたメタルジグ(細長い菱形)
            cx, cy = S * 0.5, S * 0.5
            # 45度回転座標
            u = (x - cx) * 0.7071 + (y - cy) * 0.7071
            v = -(x - cx) * 0.7071 + (y - cy) * 0.7071
            half_len = S * 0.30
            half_wid = S * 0.075
            if abs(u) < half_len:
                taper = 1 - abs(u) / half_len
                if abs(v) < half_wid * (0.35 + 0.65 * taper):
                    # 片側ハイライト、片側シェード
                    shade = (v + half_wid) / (2 * half_wid)
                    r, g, b = lerp(jig_hi, jig_lo, max(0.0, min(1.0, shade)))
            # フックのアイ(上端)と針先(下端)の点
            for (hx, hy) in [(cx - half_len * 0.7071, cy - half_len * 0.7071),
                             (cx + half_len * 0.7071, cy + half_len * 0.7071)]:
                if (x - hx) ** 2 + (y - hy) ** 2 < (S * 0.03) ** 2:
                    r, g, b = hook
            row += bytes((r, g, b, a))
        px += row
    return bytes(px)

def write_png(path, S, raw):
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0)  # RGBA
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))

if __name__ == "__main__":
    for S, name in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "icon-180.png")]:
        write_png(name, S, make_pixels(S))
        print(name, "done")
