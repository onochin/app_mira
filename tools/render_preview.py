"""Render an independent, static 3D feasibility preview with existing Pillow.

Does not use a browser. No input files are modified. No interpolation between
measurement planes or between image samples. Requires the existing Pillow.
"""
from __future__ import annotations

from array import array
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from build_probe import ROOT, read_cfg, read_values


def main():
    source = ROOT / "261113"
    cfg = read_cfg(source / "W10_A-B_MI_vW9_c1.cfg")
    width, height = int(cfg[11]), int(cfg[12])
    # Read the generated color table without executing the JS payload.
    line = (ROOT / "archive/prototype/data.js").read_text(encoding="utf-8").splitlines()[1]
    meta = json.loads(line.removeprefix("window.MIRA_DATA = ").removesuffix(";"))
    palette = meta["palette"]
    scans = [read_values(source / f"{name}.bin", width, height) for name in meta["names"]]
    output = Image.new("RGB", (1440, 930), "#f5f6f7")
    fontfile = "C:/Windows/Fonts/meiryo.ttc"
    font = ImageFont.truetype(fontfile, 15)
    small = ImageFont.truetype(fontfile, 12)
    heading = ImageFont.truetype(fontfile, 23)
    draw = ImageDraw.Draw(output)
    draw.text((30, 18), "MIRA 3D 表示検証  /  261113", font=heading, fill="#203748")
    draw.text((30, 56), "45断面・横100 mm間隔・測定位置0–4,400 mm・深さ0–750 mm", font=font, fill="#536875")
    draw.text((30, 87), "実寸比 / 断面間の補間なし / 表示強度の下限100 / 不透明度75%", font=small, fill="#536875")
    cw, ch = 1380, 505
    canvas = Image.new("RGBA", (cw, ch), "#101c29")
    yaw, pitch = -.48, .55
    cy, sy, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch)
    length, hs, ds = meta["lengthMm"], meta["heightSpanMm"], meta["depthMm"]

    def rotate(x, y, z):
        rx, rz = cy*x + sy*z, -sy*x + cy*z
        return rx, cp*y - sp*rz

    corners = [rotate(x,y,z) for x in [-length/2,length/2]
               for y in [-hs/2,hs/2] for z in [-ds/2,ds/2]]
    span = max(max(abs(p[0]) for p in corners)/(cw/ch), max(abs(p[1]) for p in corners)) * 1.24

    def project(x, y, z):
        rx, ry = rotate(x,y,z)
        return cw/2 + rx/(span*cw/ch)*cw/2, ch/2 - ry/span*ch/2

    for n, scan in enumerate(scans):
        x = n * meta["stepMm"] - length / 2
        pixels = bytearray()
        for value in scan:
            alpha = round(255*.75*(.25+.75*(value-100)/154)) if value >= 100 else 0
            pixels.extend((*palette[value], alpha))
        section = Image.frombytes("RGBA", (width, height), bytes(pixels))
        p0 = project(x, -hs/2, ds/2)
        p1 = project(x, hs/2, ds/2)
        p2 = project(x, -hs/2, -ds/2)
        ax, ay = (p1[0]-p0[0])/width, (p1[1]-p0[1])/width
        bx, by = (p2[0]-p0[0])/height, (p2[1]-p0[1])/height
        det = ax*by-ay*bx
        inverse = (by/det, -bx/det, (bx*p0[1]-by*p0[0])/det,
                   -ay/det, ax/det, (ay*p0[0]-ax*p0[1])/det)
        plane = section.transform((cw,ch), Image.Transform.AFFINE, inverse,
                                  resample=Image.Resampling.NEAREST)
        canvas = Image.alpha_composite(canvas, plane)
    pen = ImageDraw.Draw(canvas)
    box = [(x,y,z) for x in [-length/2,length/2] for y in [-hs/2,hs/2] for z in [ds/2,-ds/2]]
    for a in range(8):
        for bit in [1,2,4]:
            b=a^bit
            if b>a: pen.line([project(*box[a]),project(*box[b])], fill="#657c8d", width=1)

    def label(point, text, dx=0, dy=0):
        px, py = project(*point)
        pen.text((px+dx,py+dy),text,font=small,fill="#c7d9e7",anchor="mt",stroke_width=2,stroke_fill="#101c29")

    for d in [0,1000,2000,3000,4000,4400]:
        label((d-length/2,-hs/2,ds/2),str(d),dy=9)
    label((0,-hs/2,ds/2),"横位置 mm",dy=30)
    label((-length/2,hs/2,ds/2),"高さ +257 mm",dx=-10,dy=-27)
    label((-length/2,-hs/2,-ds/2),"深さ 750 mm",dy=12)
    output.paste(canvas.convert("RGB"), (30,119))
    draw = ImageDraw.Draw(output)
    draw.text((30, 638), "横位置 × 深さ（高さ方向の最大強度）", font=font, fill="#334d5e")
    mip = Image.new("RGB", (len(scans),height))
    pixels = mip.load()
    for n, scan in enumerate(scans):
        for z in range(height):
            value=max(scan[z*width:(z+1)*width])
            pixels[n,z]=tuple(palette[value]) if value >= 100 else (0,0,0)
    output.paste(mip.resize((1320,140),Image.Resampling.NEAREST),(80,672))
    for d in [0,250,500,750]:
        draw.text((70,672+d/ds*140),str(d),font=small,fill="#536875",anchor="rm")
    for d in [0,1000,2000,3000,4000,4400]:
        draw.text((80+(d/100+.5)/45*1320,819),str(d),font=small,fill="#536875",anchor="mt")
    draw.text((30, 856), "配置の仮置き：c1→c45が測定順・中心高さは一定・元画面X＋を上向き。", font=small, fill="#536875")
    draw.text((30, 881), "保存済み表示強度の可視化です。絶対振幅の校正、反射原因・欠陥形状の判定はしていません。", font=small, fill="#536875")
    destination=ROOT / "archive/prototype/3D_preview.png"
    output.save(destination)
    print(f"Rendered {len(scans)} measured planes to {destination}")


if __name__ == "__main__":
    main()
