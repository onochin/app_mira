"""Build the offline feasibility viewer for the supplied MIRA Classic dataset.

Python standard library only. Input files are opened read-only.
"""

from __future__ import annotations

import argparse
from array import array
import base64
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import struct
import sys


ROOT = Path(__file__).resolve().parents[1]


def read_cfg(path):
    return {int(k): float(v) for k, v in
            (line.split(":", 1) for line in path.read_text().splitlines())}


def read_values(path, width, height):
    raw = path.read_bytes()
    if len(raw) != width * height * 4:
        raise ValueError(f"Unexpected byte count: {path.name}")
    values = array("i")
    values.frombytes(raw)
    if values.itemsize != 4:
        raise ValueError("A 32-bit integer array is required")
    if sys.byteorder != "little":
        values.byteswap()
    if min(values) < 0 or max(values) > 254:
        raise ValueError(f"Unexpected intensity range: {path.name}")
    # Source storage is depth-major, with the section X axis reversed.
    return bytes(v for row in range(height)
                 for v in reversed(values[row * width:(row + 1) * width]))


def bmp_pixels(path):
    raw = path.read_bytes()
    if raw[:2] != b"BM":
        raise ValueError(f"Not a BMP: {path.name}")
    offset = struct.unpack_from("<I", raw, 10)[0]
    width, height, planes, bits, compression = struct.unpack_from("<iiHHI", raw, 18)
    if (width, height, planes, bits, compression) != (640, 480, 1, 16, 0):
        raise ValueError(f"Unsupported verification BMP: {path.name}")
    stride = ((width * bits + 31) // 32) * 4
    def pixel(x, y):
        value = struct.unpack_from("<H", raw, offset + (height - 1 - y) * stride + x * 2)[0]
        # BI_RGB at 16 bits uses RGB555, not RGB565.
        return (((value >> 10) & 31) * 255 // 31,
                ((value >> 5) & 31) * 255 // 31,
                (value & 31) * 255 // 31)

    return pixel


def build(input_dir, step_mm):
    if not step_mm > 0:
        raise ValueError("step-mm must be positive")
    files = list(input_dir.glob("*_c*.bin"))
    files.sort(key=lambda p: int(re.search(r"_c(\d+)$", p.stem).group(1)))
    if not files:
        raise ValueError("No numbered MIRA .bin files found")
    numbers = [int(re.search(r"_c(\d+)$", p.stem).group(1)) for p in files]
    if numbers != list(range(numbers[0], numbers[-1] + 1)):
        raise ValueError("Missing or duplicate scan numbers; verify measurement positions first")
    cfgs = [read_cfg(p.with_suffix(".cfg")) for p in files]
    geometry = [(int(c[11]), int(c[12]), c[7], c[9], c[10]) for c in cfgs]
    if len(set(geometry)) != 1:
        raise ValueError("Section geometries differ; explicit resampling is required")
    width, height, h_min, h_span, depth = geometry[0]
    if (width, height) != (296, 432):
        raise ValueError("This probe's BMP verification is specific to 296 x 432 sections")
    scans = [read_values(p, width, height) for p in files]

    # Infer the device's color table directly from the saved first screenshot,
    # omitting its overlaid crosshair. The image starts at (294, 42).
    first_pixel = bmp_pixels(files[0].with_suffix(".bmp"))
    candidates = defaultdict(Counter)
    for y in range(height):
        for x in range(width):
            if x == int(cfgs[0][17]) or y == int(cfgs[0][18]):
                continue
            candidates[scans[0][y * width + x]][first_pixel(294 + x, 42 + y)] += 1
    if set(candidates) != set(range(255)):
        raise ValueError("Cannot infer the complete device color table")
    palette = [list(candidates[v].most_common(1)[0][0]) for v in range(255)]
    verification = []
    for path, scan, cfg in zip(files, scans, cfgs):
        pixel = bmp_pixels(path.with_suffix(".bmp"))
        compared = mismatches = 0
        for y in range(height):
            for x in range(width):
                if x == int(cfg[17]) or y == int(cfg[18]):
                    continue
                compared += 1
                mismatches += tuple(palette[scan[y * width + x]]) != pixel(294 + x, 42 + y)
        if mismatches:
            raise ValueError(f"BMP verification failed: {path.name}: {mismatches} mismatches")
        verification.append({"file": path.name, "pixels_compared": compared,
                             "pixels_mismatched": mismatches,
                             "bin_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                             "cfg_sha256": hashlib.sha256(path.with_suffix('.cfg').read_bytes()).hexdigest(),
                             "bmp_sha256": hashlib.sha256(path.with_suffix('.bmp').read_bytes()).hexdigest()})

    meta = {"folder": input_dir.name, "count": len(files), "width": width,
            "height": height, "stepMm": step_mm,
            "lengthMm": (len(files) - 1) * step_mm,
            "heightMinMm": h_min, "heightSpanMm": h_span, "depthMm": depth,
            "names": [p.stem for p in files], "numbers": numbers,
            "palette": palette}
    output = ROOT / "archive" / "prototype"
    output.mkdir(exist_ok=True)
    encoded = base64.b64encode(b"".join(scans)).decode("ascii")
    (output / "data.js").write_text(
        "// Generated by tools/build_probe.py; saved display intensity, not dB.\n"
        "window.MIRA_DATA = " + json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + ";\n"
        'window.MIRA_BASE64 = "' + encoded + '";\n', encoding="utf-8")
    report = {"source": input_dir.name, "scan_count": len(files),
              "shape": [len(files), height, width], "stored_format": "int32 little endian, 0..254",
              "display_transform": "reverse each 296-value row; no depth reversal",
              "bitmap_crop": [294, 42, 296, 432],
              "total_pixels_compared": sum(v["pixels_compared"] for v in verification),
              "total_pixels_mismatched": 0,
              "placement": {"scan_step_mm": step_mm, "position_range_mm": [0, meta["lengthMm"]],
                            "section_x_range_mm": [h_min, h_min + h_span], "depth_range_mm": [0, depth]},
              "assumptions": ["c-number order is measurement order; no missing positions",
                              "probe held vertically; same measurement-center height",
                              "original screen X+ is provisionally wall height+",
                              "saved intensity retained per scan; cross-scan absolute amplitude not calibrated"],
              "files": verification}
    (output / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Built {len(files)} scans, {width} x {height}; {report['total_pixels_compared']:,} BMP pixels matched; 0 mismatches.")
    print(f"Archived viewer: {ROOT / 'archive' / 'MIRA_3D試作.html'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "261113")
    parser.add_argument("--step-mm", type=float, default=100)
    args = parser.parse_args()
    build(args.input.resolve(), args.step_mm)
