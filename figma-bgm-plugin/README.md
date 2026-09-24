# BGM Info Blocks — Figma 本地插件

在「公路POV模板」里批量生成 42 个 BGM 信息块。

**为什么必须本地跑**：模板文字用的是 `DFPLiJinHeiW8-GB`（方正兰亭黑），这是你本机安装的字体。
远端 Figma MCP 在云端执行，读不到本地字体，改 `characters` 会直接报
`The font family "DFPLiJinHeiW8-GB" does not exist`。本地插件运行在桌面版里，能正常加载。

## 安装（一次性）

1. 用 **Figma 桌面版**打开「公路POV模板」文件
   （浏览器版不行，插件读不到系统字体）
2. 菜单 **Plugins → Development → Import plugin from manifest…**
3. 选择本目录下的 `manifest.json`
   （路径：`E:\Workspace\^曲靖-洛阳\pr_scripts\figma-bgm-plugin\manifest.json`）

## 运行

1. **选中模板块 `bgm_template`**
   （不选也行，会按 ID `5489:439` 回退查找）
2. **Plugins → Development → BGM Info Blocks**
3. 跑完会在底部弹出摘要，并自动选中 + 定位到生成的 42 个块

## 产出

- 数据表 58 条（第 1~7 块，无缺号）→ **每行 5 个，按区块换行**，共 14 行
- 统一间距 40px
- frame 名为 `bgm` + 序号：`bgm1-1` … `bgm7-7`
- `歌曲名` 层填歌名，`歌手名` 层填歌手（多歌手已用 ` / ` 连接）
- **模板本身不会被修改**

### 增量避让（重要）

插件**只创建还不存在的块**，并且从已有块的下方接着排：

- 已存在的 `bgmX-Y`（按名字判断）会被**跳过**，不重复创建
- 新块的起始 y = 已有块的最低底边 + `gap`；若一个都没有，则从模板下方开始

所以往 `DATA` 里追加新块后直接重跑即可，已做好的块不会被动。摘要弹窗会写明
`生成 N 个｜避让已存在的 M 个`。

## 配置

`code.js` 顶部的 `CONFIG`：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `cols` | `5` | 每行几个 |
| `gap` | `40` | 统一间距 |
| `namePrefix` | `'bgm'` | 名称前缀，完整名为 前缀 + 序号（如 `bgm1-1`） |
| `autoFit` | `false` | `true` 时歌名超宽自动缩小字号（下限 `minFontScale`） |
| `cleanupFirst` | `false` | `true` 时先删掉本插件生成过的块再重建 |
| `minFontScale` | `0.6` | autoFit 的字号下限 |

## ⚠️ 歌名溢出（首次运行后留意弹窗）

模板的 `歌曲名` 层是 `WIDTH_AND_HEIGHT` 自动宽度，父容器仅 **320px 宽**。
长歌名会横向冲出卡片、压到右边邻卡。预计约 8 条会溢出，最严重的是：

```
6-7  婚礼进行曲 (Wedding March) (门德尔松版)
6-5  花簪 HANAKANZASHI
4-8  由我执棋 (Checkmate)
1-4  Theoretical Simulation
2-5  DAYBREAK FRONTLINE
```

插件**会实测并报告**确切数量和最大宽度。三种处理方式：

1. 把 `autoFit` 设为 `true` 重跑 —— 自动缩字号（会改变视觉比例）
2. 在 Figma 里手动缩短歌名
3. 调整模板本身（加宽卡片 / 缩小字号 / 开启换行）

## 重跑

**日常追加新块：什么都不用改，直接跑。** 避让逻辑会跳过已存在的，只建新的。

**想整体重建**（改了 `cols` / `gap` / `autoFit` 等布局参数时）：
把 `cleanupFirst` 设为 `true`。它会**删除所有**名称匹配 `^bgm\d+-\d+$` 的 FRAME，然后从
头重建。⚠️ 这会一并删掉你手动改过的那些块，未提交的调整会丢。

你原有的 `bgm0`、以及那些叫 `1-1` 的 GROUP 都**不匹配该正则**，不会被误删。

## 数据来源

`DATA` 数组由仓库根目录的 `parse_bgm.py` 生成，**不要手改**。三个来源：

| 来源 | 块 | 说明 |
| --- | --- | --- |
| `bgm.txt`（行格式 `音频 N : 歌手 - 歌名.ext : 起始秒`） | 1, 2, 4, 5, 6 | |
| `EXTRA_DIRS` → `审核区/P7/BGM` | 7 | 全部支持格式 |
| `EXTRA_DIRS` → `审核区/P3` | 3 | **仅 MP3**（同目录的 `.mp4` 被排除） |

加新块：改 `bgm.txt`，或往 `parse_bgm.py` 顶部的 `EXTRA_DIRS` 加一行
`(Path("相对路径"), 块序号, 扩展名元组或 None)`，然后：

```bash
uv run parse_bgm.py        # 重新生成 bgm_blocks.json
```

再把 `DATA` 重新注入 `code.js`（用 `bgm_blocks.json` 生成 `[label, song, artist, block]`
四元组数组，整体替换 `const DATA = [...];` 那一块）。

### 人工修正 `OVERRIDES`

解析器猜不出来的条目（如 B站下载导致的文件名重复拼接），写进 `parse_bgm.py` 的
`OVERRIDES`，键为源文件基名：

```python
OVERRIDES = {
    "[1]Funk+Hiphop版《孤单北半球》！ - 1.Funk+...mp3": {
        "song": "孤单北半球",
        "artist": "Funk / Hiphop",
    },
}
```

写在配置里而不是硬编码进逻辑，重跑仍然保留。运行时会打印 `应用人工修正 N 条`。

### 自动标记的可疑条目

解析器会在 JSON 的 `flags` 字段里标记需人工确认的条目：

- 歌手名以 `_` 结尾（如 `Boney M_`，疑为 `Boney M.` 被清洗）
- 歌手与歌名互相包含（疑为文件名重复拼接）
