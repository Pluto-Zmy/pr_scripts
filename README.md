# pr_scripts

用于 Adobe Premiere Pro 的 ExtendScript 脚本集合，提供项目素材查找、音频剪辑时间输出，以及根据序列标记批量放置 BASE/MASK 素材等功能。

> [!WARNING]
> 部分脚本会使用 `overwriteClip` 覆盖时间线上的现有内容。运行前请保存项目，建议先在项目副本中验证结果。

## 脚本概览

| 脚本 | 功能 |
| --- | --- |
| `GetAllProjectItem.js` | 在项目根目录的 `base_V3` 素材箱中查找 `区界.wav`，并将其覆盖写入活动序列的 A1。 |
| `PrintBgmStartTime.js` | 读取活动序列 A2 中的所有剪辑，并在 ExtendScript 控制台输出剪辑名称与起始秒数。 |
| `PlaceMarkerSegments.js` | 根据序列标记点生成连续区间，将对应的 BASE/MASK 素材分别覆盖写入指定轨道（默认 V5、V6）。 |
| `RedistributeBgmGaps.js` | 把源音频轨（默认 A2）中间各首音乐之间的间隙重排为等长，结果写入目标音频轨（默认 A3）；源轨只读。 |

## 环境要求

- Adobe Premiere Pro，且当前版本仍能运行 ExtendScript。
- Visual Studio Code。
- Adobe ExtendScript Debugger 扩展。
- 已在 Premiere Pro 中打开项目和活动序列。

本项目使用 Premiere Pro 的 ExtendScript API。接口用法可参考 [Premiere Pro Scripting Guide](https://ppro-scripting.docsforadobe.dev/)。

## 使用方法

1. 克隆仓库并使用 VS Code 打开项目目录：

   ```bash
   git clone https://github.com/Pluto-Zmy/pr_scripts.git
   cd pr_scripts
   ```

2. 在 Premiere Pro 中打开需要操作的项目和序列。
3. 在 VS Code 中安装 Adobe ExtendScript Debugger 扩展。
4. 打开“运行和调试”，选择仓库内 `.vscode/launch.json` 提供的 `extendScript-Debug attach` 配置，并附加到 Premiere Pro。
5. 打开要运行的 `.js` 文件，通过调试器执行脚本。
6. `$.writeln(...)` 产生的内容可在 ExtendScript 调试控制台中查看。

三个脚本都会在文件末尾直接调用入口函数，执行整个文件即会立即运行对应操作。

## 脚本说明

### GetAllProjectItem.js

脚本执行以下操作：

1. 读取 Premiere Pro 的当前项目和活动序列。
2. 遍历项目根目录的直接子项，查找名称为 `base_V3` 的素材箱。
3. 在该素材箱的直接子项中查找名称为 `区界.wav` 的素材。
4. 调用活动序列 A1（`audioTracks[0]`）的 `overwriteClip(base, 10)`。

脚本当前将已验证的硬编码数值 `10` 直接作为 `overwriteClip` 的时间参数传入。README 仅记录这一现有行为，不修改其实现；如需适配其他时间位置，请结合实际 Premiere Pro 版本和项目环境验证后调整。

当前查找仅覆盖项目根目录和 `base_V3` 素材箱的直接子项，不会递归搜索更深层级。若未找到目标素材箱或素材，脚本会直接结束；若没有活动序列，访问音频轨道时可能报错。

### PrintBgmStartTime.js

脚本读取指定音频轨道中的全部剪辑，并在 ExtendScript 控制台输出：

- 活动序列名称；
- 音频轨道编号；
- 每个剪辑的序号、名称和起始秒数。

文件末尾当前调用：

```javascript
printBgmStartTime(1)
```

轨道索引从 `0` 开始，因此参数 `1` 表示 A2。如需读取 A1，可改为 `printBgmStartTime(0)`。没有活动序列或指定轨道不存在时，脚本会通过弹窗提示。

### PlaceMarkerSegments.js

脚本根据活动序列的标记点，把时间线划分为从 `0` 开始的连续区间。例如三个标记点位于 `T1`、`T2`、`T3`，生成的区间为：

```text
0 → T1
T1 → T2
T2 → T3
```

每个区间使用从 `0` 开始的序号寻找一组素材：

```text
GLT_P0_0_BASE    GLT_P0_0_MASK
GLT_P0_1_BASE    GLT_P0_1_MASK
GLT_P0_2_BASE    GLT_P0_2_MASK
```

查找时会递归遍历整个项目。文件扩展名不参与匹配，例如 `GLT_P0_0_BASE.png` 可匹配 `GLT_P0_0_BASE`。

文件末尾通过参数指定 BASE 和 MASK 的视频轨道及浅色/深色模式：

```javascript
run(5, 6, "light"); // 浅色模式
// run(5, 6, "dark"); // 深色模式，使用时替换上一行调用
```

第一个参数是 BASE 的 V 轨道编号，第二个参数是 MASK 的 V 轨道编号，均从 `1` 开始，直接对应 Premiere 中的编号。默认 `5, 6` 对应 V5、V6；例如改为 `run(3, 4)` 即写入 V3、V4。两个参数必须是不同的正整数，且对应轨道必须已存在。

第三个参数为模式：`"light"`（浅色，省略时默认）使用原文件名；`"dark"`（深色）使用扩展名前带 `_d` 后缀的文件名，例如 `GLT_P0_0_BASE_d.png` 和 `GLT_P0_0_MASK_d.png`。只查找所选模式的素材，缺失时会报错，不会回退到另一模式。

默认参数下的放置规则：

- `BASE` 素材写入 V5（`videoTracks[4]`）；
- `MASK` 素材写入 V6（`videoTracks[5]`）；
- 素材在区间起点覆盖写入；
- 新剪辑的结束点被设置为区间终点。

脚本会在执行前验证全部输入，以下情况会停止并弹出错误信息：

- 没有活动序列或序列标记；
- 模式不是 `"light"` 或 `"dark"`；
- 轨道编号不是正整数、两条轨道相同，或指定的视频轨道不存在；
- 某个 BASE/MASK 素材缺失；
- 同名素材不唯一；
- 标记点不能形成正时长区间；
- Premiere Pro 未能创建匹配剪辑或设置预期结束点。

如果部分素材已经放置后才发生错误，提示信息会建议撤销一次。完成后会弹窗显示成功放置的素材组数。

### RedistributeBgmGaps.js

脚本读取活动序列源音频轨上的全部剪辑，保持开头 `keepHead` 首和结尾 `keepTail` 首不动，
把其余各首之间的间隙重排为等长，整条新排列写入目标音频轨。**源轨全程只读。**

固定窗口是第 `keepHead` 首的结束点到最后一首的开始点。两端固定后，等长间隙只有一个解：

```text
gap = (窗口长度 − 中间各首时长之和) / (中间条数 + 1)
```

`gap` 向下取整到源轨实测的采样栅格（由现有剪辑时间点反推），因此除最后一个间隙会吸收
全部取整余数（上限为中间条数个采样）外，其余间隙严格相等。

顶部 `CONFIG`：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `"report"` | `"report"` 只试算并打印，不做任何修改；`"write"` 才写入目标轨 |
| `keepHead` | `6` | 开头保持不动的首数，必须 ≥ 1 |
| `keepTail` | `1` | 结尾保持不动的首数，必须 ≥ 1 |
| `sourceTrack` | `2` | 源音频轨（1 起，对应 A2），只读 |
| `targetTrack` | `3` | 目标音频轨（1 起，对应 A3） |
| `autoMuteSource` | `false` | 写入后是否自动静音源轨 |

运行步骤：

1. 保持 `mode = "report"` 跑一次，核对打印出的间隙值与各首位移。
2. 在 Premiere 中执行 `序列 → 添加轨道 → 音频轨 1 条`，确保目标轨存在。
   ExtendScript 无法创建轨道，目标轨不存在时脚本会中止并提示。
3. 把 `mode` 改成 `"write"` 再跑。脚本会先打印摘要和一行 `===== WRITE 模式 =====` 横幅，
   然后依次：必要时清空目标轨 → 落位预检（放一条测试剪辑验证落位精度后立即删除）→
   逐条写入 → 复读校验条数、位置与间隙。

**没有确认弹窗**：Premiere 的 ExtendScript 里没有可用的模态确认对话框（全局 `confirm`
抛 `Not Enough Parameters`，ScriptUI 的 `Window` 不存在，均在本机 Premiere 25.5 实测过）。
放行闸门就是 `mode` 开关本身 —— 它必须手动改文件才能打开。

写入失败或校验不通过时会立即中止并报告是第几条，**源轨不会被修改**。目标轨上的半成品用
`Ctrl+Z` 撤销，或直接重跑（重跑会先清空目标轨）。

写入后源轨与目标轨会同时出声，需要手动静音其中一条；`autoMuteSource = true` 可让脚本
写入后自动静音源轨。

`BgmGapPlanner` 是脚本里不依赖 Premiere 的纯计算部分，仓库内附有 Node 测试：

```bash
node --test tests/
```

## 注意事项

- Premiere Pro 的轨道集合使用零基索引：`audioTracks[0]` 是 A1，`videoTracks[4]` 是 V5。
- `overwriteClip` 会覆盖目标位置已有素材，运行前请确认目标轨道和时间范围。
- `GetAllProjectItem.js` 和 `PrintBgmStartTime.js` 含有硬编码名称、轨道或时间参数，修改后再用于其他项目结构。
- `PlaceMarkerSegments.js` 要求每个素材名称在整个项目中唯一；重复名称会导致验证失败。
- `PlaceMarkerSegments.js` 使用 ticks 字符串比较时间，避免 ExtendScript 中大整数精度造成排序错误。
- `RedistributeBgmGaps.js` 只写目标音频轨，源轨仅被读取；写入前请先保存项目，并先跑一次 `"report"` 模式核对数值。
- `RedistributeBgmGaps.js` 的测试依赖 Node.js 20 及以上（使用 `node --test`），运行 Premiere 脚本本身不需要 Node。

## 项目结构

```text
.
├── .vscode/
│   └── launch.json
├── GetAllProjectItem.js
├── PlaceMarkerSegments.js
├── RedistributeBgmGaps.js
├── tests/
│   ├── bgm_gap_planner.test.js
│   └── fixtures/
│       └── a2_clips.json
├── PrintBgmStartTime.js
├── README.md
└── docs/
    └── superpowers/
        ├── plans/
        └── specs/
```
