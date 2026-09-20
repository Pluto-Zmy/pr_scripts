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

## 注意事项

- Premiere Pro 的轨道集合使用零基索引：`audioTracks[0]` 是 A1，`videoTracks[4]` 是 V5。
- `overwriteClip` 会覆盖目标位置已有素材，运行前请确认目标轨道和时间范围。
- `GetAllProjectItem.js` 和 `PrintBgmStartTime.js` 含有硬编码名称、轨道或时间参数，修改后再用于其他项目结构。
- `PlaceMarkerSegments.js` 要求每个素材名称在整个项目中唯一；重复名称会导致验证失败。
- `PlaceMarkerSegments.js` 使用 ticks 字符串比较时间，避免 ExtendScript 中大整数精度造成排序错误。

## 项目结构

```text
.
├── .vscode/
│   └── launch.json
├── GetAllProjectItem.js
├── PlaceMarkerSegments.js
├── PrintBgmStartTime.js
├── README.md
└── docs/
    └── superpowers/
        ├── plans/
        └── specs/
```
