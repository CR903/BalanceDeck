#!/usr/bin/env python3
"""一次性工具：按 sourcemap 把 bundle 的字节数归因到源文件（实现前调研用，不进产品代码）。

用法: python3 sourcemap-attrib.py <chunk.js.map> [topN]
"""
import json
import sys

B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'


def decode_vlq(seg):
    out, shift, val = [], 0, 0
    for ch in seg:
        d = B64.index(ch)
        cont = (d & 0x20) != 0
        d &= 0x1F
        val += d << shift
        if cont:
            shift += 5
        else:
            out.append((-(val & 1) if (val & 1) else (val >> 1)))
            shift, val = 0, 0
    return out


def main():
    path = sys.argv[1]
    topn = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    m = json.load(open(path))
    srcs = m['sources']
    contrib = {}
    src_idx = 0
    src_line = 0
    src_col = 0
    for line in m['mappings'].split(';'):
        gc = 0
        for seg in line.split(','):
            if not seg:
                continue
            vals = decode_vlq(seg)
            if not vals:
                continue
            gc += vals[0]
            if len(vals) >= 4:
                src_idx += vals[1]
                src_line += vals[2]
                src_col += vals[3]
            s = srcs[src_idx] if 0 <= src_idx < len(srcs) else '?'
            contrib[s] = contrib.get(s, 0) + len(seg)
    total = sum(contrib.values())
    print(f'{path}\n  decoded bytes ≈ {total}\n')
    for k, v in sorted(contrib.items(), key=lambda x: -x[1])[:topn]:
        print(f'  {v:8d}  {100.0*v/total:5.1f}%  {k}')
    # 按目录聚合
    agg = {}
    for k, v in contrib.items():
        key = '/'.join(k.split('/')[-2:]) if 'node_modules' in k else k.rsplit('/', 1)[0]
        agg[key] = agg.get(key, 0) + v
    print('\n  --- 按目录聚合 ---')
    for k, v in sorted(agg.items(), key=lambda x: -x[1])[:20]:
        print(f'  {v:8d}  {100.0*v/total:5.1f}%  {k}')


if __name__ == '__main__':
    main()