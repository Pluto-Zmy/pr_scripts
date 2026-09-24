#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 bgm.txt 加额外素材目录解析成信息块数据表。

用法:  python parse_bgm.py     (或 uv run parse_bgm.py)

输出:
  bgm_blocks.csv   逗号分隔，含 BOM，Excel 直接打开不乱码
  bgm_blocks.json  供后续程序 / Figma 插件脚本使用

数据源:
  1. 仓库根目录的 bgm.txt（行格式：音频 N : 歌手 - 歌名.ext : 起始秒）
  2. EXTRA_DIRS 里列出的素材目录（直接扫描音频文件名）

编号规则:
  序号为 X-Y，X 是块序号，Y 是块内序号，均从 1 开始。
  块序号优先取文件名里已有的前缀 (2-1 / 4-1 / 6-1 / 7-1 / [1])；
  无前缀的按项目约定: 音频 1-9 -> 第 1 块, 音频 26-34 -> 第 5 块。
  数据中不存在第 3 块。

关于歌手分隔符: 只认 、(U+3001) / ,(U+002C) / " _ "。
  不能认 丶(U+4E36) —— "宁采臣丶在唱歌" 里的它是用户名本身的一部分。
"""
from __future__ import annotations

import csv
import json
import re
import sys
from collections import OrderedDict, Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "bgm.txt"
OUT_CSV = HERE / "bgm_blocks.csv"
OUT_JSON = HERE / "bgm_blocks.json"

# 无文件名前缀时的块序号约定
FALLBACK_BLOCKS = ((1, 9, 1), (26, 34, 5))

# 额外素材目录：(相对本文件的路径, 块序号, 只接受的扩展名元组 或 None=用 EXT_RE)
# 这些目录直接按音频文件名解析，与 bgm.txt 合并
EXTRA_DIRS = (
    (Path("../审核区/P7/BGM"), 7, None),
    (Path("../审核区/P3"), 3, (".mp3",)),   # 仅 MP3；同目录下有一个 .mp4 要排除
)

# 人工修正：按源文件基名覆盖自动解析结果（解析器猜不出来的条目）。
# 写在这里而不是硬编码进逻辑，这样重跑仍然保留修正。
OVERRIDES = {
    # B站下载的文件名被重复拼接了两遍，歌手字段无意义，由用户指定
    "[1]Funk+Hiphop版《孤单北半球》！ - 1.Funk+Hiphop版《孤单北半球》！(Av116912365242226,P1).mp3": {
        "song": "孤单北半球",
        "artist": "Funk / Hiphop",
    },
}

EXT_RE = re.compile(r"\.(wav|mp3|m4a|flac|aac)$", re.I)
LINE_RE = re.compile(r"^音频\s*(\d+)\s*:\s*(.*?)\s*:\s*([\d.]+)\s*$")
PREFIX_RES = (
    re.compile(r"^\[(\d+)\]\s*"),          # [3]Tobu,Itro - Fantasy
    re.compile(r"^(\d+)-(\d+)\s*-\s*"),    # 2-1 - Ed Sheeran-...
    re.compile(r"^(\d+)-(\d+)\s+"),        # 4-5 CH17S - Shadows
)


def strip_prefix(name: str) -> tuple[int | None, str | None, str]:
    """剥离块前缀，返回 (块序号, 块内序号, 剩余文本)。"""
    m = PREFIX_RES[0].match(name)
    if m:
        return None, m.group(1), name[m.end():]
    for rx in PREFIX_RES[1:]:
        m = rx.match(name)
        if m:
            return int(m.group(1)), m.group(2), name[m.end():]
    return None, None, name


def split_artists(field: str) -> list[str]:
    parts = re.split(r"\s+_\s+|、|,", field)
    return [p.strip() for p in parts if p.strip()]


def split_artist_song(body: str) -> tuple[str, str]:
    """分离歌手 / 歌名。

    优先首个带空格的 " - " —— 保护 "Next 2 U -eUC-" 这类自带连字符的歌名；
    没有时才退回最后一个 '-' —— 处理 "铁痕电台-MSR,SKa2or-洪炉" 这类无空格写法。
    """
    if " - " in body:
        left, right = body.split(" - ", 1)
        return left.strip(), right.strip()
    idx = body.rfind("-")
    if idx == -1:
        return body.strip(), ""
    return body[:idx].strip(), body[idx + 1:].strip()


def parse(path: Path) -> list[dict]:
    rows: list[dict] = []
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        m = LINE_RE.match(raw)
        if not m:
            print(f"[跳过] 第 {lineno} 行无法匹配: {raw}", file=sys.stderr)
            continue

        audio = int(m.group(1))
        blk, in_blk, body = strip_prefix(m.group(2))
        body = EXT_RE.sub("", body)
        artist_field, song = split_artist_song(body)

        rows.append({
            "audio": audio,
            "song": song,
            "artists": split_artists(artist_field),
            "artist": " / ".join(split_artists(artist_field)),
            "start": round(float(m.group(3)), 2),
            "_blk": blk,
            "_in_blk": in_blk,
            "_flags": [],
            "_file": f"bgm.txt#{lineno}",
        })
    return rows


def apply_overrides(rows: list[dict]) -> int:
    """按 OVERRIDES 覆盖字段。返回被修正的条数。"""
    n = 0
    for r in rows:
        ov = OVERRIDES.get(r.get("_file") or "")
        if not ov:
            continue
        if "song" in ov:
            r["song"] = ov["song"]
        if "artist" in ov:
            r["artist"] = ov["artist"]
            r["artists"] = split_artists(ov["artist"])
        if "start" in ov:
            r["start"] = ov["start"]
        # 已人工确认，去掉此前基于猜测的提示
        r["_flags"] = [f for f in r["_flags"] if "重复拼接" not in f]
        r["_overridden"] = True
        n += 1
    return n


def parse_dir(directory: Path, block: int, exts=None) -> list[dict]:
    """扫描素材目录，直接按音频文件名解析条目。

    与 bgm.txt 的区别：没有音频序号、没有起始秒。块序号取文件名前缀，
    无前缀时用调用方传入的 block。

    exts 给出时只接受这些扩展名（小写，含点），否则用 EXT_RE。
    """
    if not directory.exists():
        print(f"[警告] 目录不存在，跳过: {directory}", file=sys.stderr)
        return []

    rows: list[dict] = []
    for f in sorted(directory.iterdir()):
        if not f.is_file() or f.name.startswith("."):
            continue
        if exts is not None:
            if f.suffix.lower() not in exts:
                continue
        elif not EXT_RE.search(f.name):
            continue

        stem = EXT_RE.sub("", f.name)
        blk_from_name, in_blk, body = strip_prefix(stem)
        artist_field, song = split_artist_song(body)
        artists = split_artists(artist_field)

        rows.append({
            "audio": None,
            "song": song,
            "artists": artists,
            "artist": " / ".join(artists),
            "start": None,
            "_blk": blk_from_name if blk_from_name is not None else block,
            "_in_blk": in_blk,
            "_flags": [],
            "_source": directory.name + "/" + f.name,
            "_file": f.name,
        })
    return rows


def assign_blocks(rows: list[dict]) -> None:
    for r in rows:
        n = r["audio"]
        if r["_blk"] is not None:
            r["block"] = r["_blk"]
        elif n is not None:
            r["block"] = next(
                (b for lo, hi, b in FALLBACK_BLOCKS if lo <= n <= hi), None
            )
        else:
            r["block"] = None
        if r["block"] is None:
            r["_flags"].append("块序号无法推定")

    groups: OrderedDict = OrderedDict()
    for r in rows:
        groups.setdefault(r["block"], []).append(r)
    for blk, members in groups.items():
        # 块内排序：带文件名序号前缀的按其排序；没有的（如第1/5块）保持原顺序
        # 稳定排序保证 key 相同时不打乱原有次序
        members.sort(key=lambda r: int(r["_in_blk"]) if r["_in_blk"] is not None else 10 ** 6)
        for i, r in enumerate(members, 1):
            r["index_in_block"] = i
            r["label"] = f"{blk}-{i}" if blk is not None else f"?-{i}"

    # 块内序号与文件名前缀交叉校验
    for r in rows:
        if r["_in_blk"] is not None and str(r["index_in_block"]) != r["_in_blk"]:
            r["_flags"].append(
                f"序号不符: 文件名前缀={r['_in_blk']} 推算={r['index_in_block']}"
            )
        if "artist" in r and r["artist"].endswith("_"):
            r["_flags"].append("歌手名以 '_' 结尾，疑为文件名清洗残留（如 Boney M_ -> Boney M.）")
        # 歌手与歌名互相包含 → 多半是标题被重复拼接（B站等下载器常见）
        if r["artist"] and r["song"] and (r["artist"] in r["song"] or r["song"] in r["artist"]):
            r["_flags"].append("歌手与歌名高度重复，疑似文件名重复拼接，需人工确认")


def main() -> int:
    if not SRC.exists():
        print(f"找不到 {SRC}", file=sys.stderr)
        return 1

    rows = parse(SRC)
    print(f"从 bgm.txt 解析 {len(rows)} 条")

    for d, blk, exts in EXTRA_DIRS:
        extra = parse_dir(HERE / d, blk, exts)
        if extra:
            scope = "仅 " + "/".join(e.lstrip(".").upper() for e in exts) if exts else "全部支持格式"
            print(f"从 {d} 解析 {len(extra)} 条（第 {blk} 块，{scope}）")
        rows += extra

    overridden = apply_overrides(rows)   # 必须在 assign_blocks 之前，避免误报警告
    if overridden:
        print(f"应用人工修正 {overridden} 条（OVERRIDES）")

    assign_blocks(rows)
    # 按 (块序号, 块内序号) 排列，None 排最后
    rows.sort(key=lambda r: (r["block"] if r["block"] is not None else 999,
                             r["index_in_block"]))
    for r in rows:
        r["source"] = r.get("_source") or f"bgm.txt (音频 {r['audio']})"

    flagged = [r for r in rows if r["_flags"]]
    print(f"解析 {len(rows)} 条")
    counts = Counter(r["block"] for r in rows)
    print("块分布: " + "  ".join(
        f"第{b}块={counts[b]}条" for b in sorted(k for k in counts if k is not None)
    ))
    if None in counts:
        print(f"未分块: {counts[None]} 条")
    print(f"需人工确认: {len(flagged)} 条")
    for r in flagged:
        print(f"  ! {r['label']} {r['song']} — {'; '.join(r['_flags'])}")

    cols = ["label", "song", "artist", "audio", "block", "index_in_block", "start", "source"]
    with OUT_CSV.open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["序号", "歌曲名", "歌手", "音频序号", "块序号", "块内序号", "起始秒", "来源"])
        for r in rows:
            w.writerow([r[c] for c in cols])

    OUT_JSON.write_text(
        json.dumps(
            [{c: r[c] for c in cols} | {"flags": r["_flags"]} for r in rows],
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )

    print(f"\n-> {OUT_CSV.name}\n-> {OUT_JSON.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
