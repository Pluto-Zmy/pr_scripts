// BGM 信息块批量生成插件
// 在 Figma 桌面版运行，因此可以加载本机安装的字体（远端 MCP 做不到这一点）。
//
// 用法：
//   1. 在 Figma 桌面版打开「公路POV模板」文件
//   2. 选中模板块 bgm_template（不选则按 ID/名称查找）
//   3. Plugins → Development → BGM Info Blocks
//
// 数据由仓库根目录的 parse_bgm.py 从 bgm.txt 生成，勿手改。

const CONFIG = {
  cols: 5,           // 每行几个
  gap: 40,           // 统一间距
  namePrefix: 'bgm', // 生成块的名称前缀，完整名为 前缀 + 序号（如 bgm1-1）
  autoFit: false,    // true: 歌名超出卡片宽度时自动缩小字号
  cleanupFirst: false, // true: 先删除本插件生成过的块再重建（重跑用）
  minFontScale: 0.6, // autoFit 时字号下限（相对原始字号）
};

const TEMPLATE_ID = '5489:439';
const TEMPLATE_NAME = 'bgm_template';

// 由 parse_bgm.py 注入：[序号, 歌曲名, 歌手, 块序号]
const DATA = [
  ["1-1", "绝体绝命", "阿良良木健 / 洛天依Official", 1],
  ["1-2", "洪炉", "铁痕电台-MSR / SKa2or", 1],
  ["1-3", "让你知道", "汪苏泷 / G.E.M.邓紫棋", 1],
  ["1-4", "Theoretical Simulation", "塞壬唱片-MSR / SKa2or", 1],
  ["1-5", "Watch Me Shine", "Joanna Pacitti", 1],
  ["1-6", "Strategic Evolution", "cleanmindsounds", 1],
  ["1-7", "天上凉都", "颜婷易兰", 1],
  ["1-8", "Windows", "Infraction Music", 1],
  ["1-9", "Faded", "Izzy Bizu", 1],
  ["2-1", "Shape of You", "Ed Sheeran", 2],
  ["2-2", "Cure For Me", "AURORA", 2],
  ["2-3", "风雨无阻", "周华健", 2],
  ["2-4", "Dream in the Night", "FELT", 2],
  ["2-5", "DAYBREAK FRONTLINE", "Orangestar / IA", 2],
  ["2-6", "花月", "Kirara Magic", 2],
  ["2-7", "亲爱的", "潘玮柏", 2],
  ["3-1", "孤单北半球", "Funk / Hiphop", 3],
  ["3-2", "渇く、憂う", "トゲナシトゲアリ", 3],
  ["3-3", "夏の幻", "GARNET CROW", 3],
  ["3-4", "The Nights", "Avicii / Nicholas Furlong", 3],
  ["3-5", "上上签", "言和", 3],
  ["3-6", "随心歌", "西瓜JUN", 3],
  ["3-7", "只是有人留在了昨天", "供销社乐队", 3],
  ["3-8", "出卖", "周传雄", 3],
  ["3-9", "只对你有感觉", "林俊杰", 3],
  ["4-1", "不知", "璟轩 / 醉雪 / 汐音社", 4],
  ["4-2", "Acrise", "EspiDev / L. Mity", 4],
  ["4-3", "飞花入梦", "兰音Reine", 4],
  ["4-4", "双契辞", "龟娘 / 银临", 4],
  ["4-5", "Shadows", "CH17S", 4],
  ["4-6", "云端循环", "逆时针向", 4],
  ["4-7", "孑然记", "KBShinya / 兰音Reine", 4],
  ["4-8", "由我执棋 (Checkmate)", "椒椒JMJ", 4],
  ["4-9", "别寒江", "三无Marblue", 4],
  ["5-1", "A Moment Apart", "ODESZA", 5],
  ["5-2", "Fantasy", "Tobu / Itro", 5],
  ["5-3", "Windfall", "TheFatRat", 5],
  ["5-4", "Rada", "Thomas Bergersen", 5],
  ["5-5", "White Sails", "Marcus Warner", 5],
  ["5-6", "Exodus", "Maksim Mrvica", 5],
  ["5-7", "后会无期", "徐良 / 汪苏泷", 5],
  ["5-8", "梦里可是谁", "蔡国权", 5],
  ["5-9", "两忘烟水里", "关菊英 / 关正杰", 5],
  ["6-1", "兔侠功夫操", "凤凰传奇", 6],
  ["6-2", "你是我的菜", "王麟", 6],
  ["6-3", "Next 2 U -eUC-", "澤野弘之 (さわの ひろゆき) / naNami", 6],
  ["6-4", "Sunny", "Boney M_", 6],
  ["6-5", "花簪 HANAKANZASHI", "立花理香 (たちばな りか)", 6],
  ["6-6", "故剑情深", "宁采臣丶在唱歌", 6],
  ["6-7", "婚礼进行曲 (Wedding March) (门德尔松版)", "Classical Artists", 6],
  ["6-8", "HandClap", "Fitz and The Tantrums", 6],
  ["7-1", "Night of fire", "Niko", 7],
  ["7-2", "GET ME POWER", "Mega NRG Man", 7],
  ["7-3", "Crazy Little Love", "Nuage", 7],
  ["7-4", "Reinvent", "Sound Souler", 7],
  ["7-5", "Paradise", "Sound Souler", 7],
  ["7-6", "3rd Avenue", "Sound Souler", 7],
  ["7-7", "Scar in the Earth", "猫叉Master (さとう なおゆき)", 7]
];

(async () => {
  try {
    const tpl = findTemplate();
    if (!tpl.node) {
      figma.closePlugin('✗ 找不到模板块。请先选中 bgm_template 再运行。');
      return;
    }
    const template = tpl.node;

    if (!DATA.length) {
      figma.closePlugin('✗ 数据为空，code.js 里的 DATA 没被正确注入。');
      return;
    }

    const { song: tSong, artist: tArtist } = pickTextLayers(template);
    if (!tSong || !tArtist) {
      figma.closePlugin('✗ 模板里找不到「歌曲名」/「歌手名」文字层。');
      return;
    }

    // 字体必须从节点自身读取，加载后才能改 characters
    await loadFontsOf(tSong);
    await loadFontsOf(tArtist);

    const songFontSize = tSong.fontSize;
    const artistFontSize = tArtist.fontSize;
    // 文字层可用宽度取其父容器宽度
    const availableWidth = tSong.parent ? tSong.parent.width : template.width;

    const W = template.width;
    const H = template.height;
    const x0 = template.x;

    const removedCount = CONFIG.cleanupFirst ? removeGenerated(template) : 0;

    // 避让已做好的块：跳过同名，并从它们下方接着排
    const existingNames = new Set();
    let maxBottom = null;
    for (const n of figma.currentPage.children) {
      if (n.type !== 'FRAME' || n.id === template.id) continue;
      if (!namePattern().test(n.name)) continue;
      existingNames.add(n.name);
      const b = n.y + n.height;
      if (maxBottom === null || b > maxBottom) maxBottom = b;
    }
    const y0 = maxBottom !== null ? maxBottom + CONFIG.gap
                                  : template.y + H + CONFIG.gap;

    // 按块分组，块之间不共行
    const blocks = groupByBlock(DATA);

    const created = [];
    const overflow = [];
    const skipped = [];
    let row = 0;

    for (const block of blocks) {
      const pending = block.items.filter(it => !existingNames.has(CONFIG.namePrefix + it[0]));
      if (!pending.length) {
        skipped.push(...block.items.map(it => it[0]));
        continue;
      }

      for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        const [label, songName, artistName] = item;

        const col = i % CONFIG.cols;
        const r = row + Math.floor(i / CONFIG.cols);

        const node = template.clone();
        node.name = CONFIG.namePrefix + label;
        node.x = x0 + col * (W + CONFIG.gap);
        node.y = y0 + r * (H + CONFIG.gap);

        const songClone = node.findOne(n => n.type === 'TEXT' && n.name === tSong.name);
        const artistClone = node.findOne(n => n.type === 'TEXT' && n.name === tArtist.name);
        if (songClone) {
          songClone.fontSize = songFontSize;
          songClone.characters = songName;
          if (CONFIG.autoFit && songClone.width > availableWidth) {
            songClone.fontSize = fitFontSize(songFontSize, availableWidth, songClone);
          }
          if (songClone.width > availableWidth) {
            overflow.push({ label, song: songName, width: Math.round(songClone.width) });
          }
        }
        if (artistClone) {
          artistClone.fontSize = artistFontSize;
          artistClone.characters = artistName;
        }

        created.push(node.id);
      }

      row += Math.ceil(pending.length / CONFIG.cols);
    }

    if (created.length) {
      const nodes = created.map(id => figma.getNodeById(id)).filter(Boolean);
      figma.currentPage.selection = nodes;
      figma.viewport.scrollAndZoomIntoView(nodes);
    }

    const parts = [`生成 ${created.length} 个信息块（${row} 行）｜模板来源：${tpl.source}`];
    if (removedCount) parts.push(`先删除 ${removedCount} 个旧块`);
    if (skipped.length) parts.push(`避让已存在的 ${skipped.length} 个`);
    if (!created.length) parts.push('无新增，全部已存在');

    let msg = '✓ ' + parts.join('｜');
    if (overflow.length) {
      msg += `\n⚠ ${overflow.length} 个歌名超出卡片宽度（最宽 ${Math.max(...overflow.map(o => o.width))}px / 可用 ${Math.round(availableWidth)}px）`;
      if (!CONFIG.autoFit) msg += '，可把 CONFIG.autoFit 设为 true 重跑';
    }
    figma.closePlugin(msg);
  } catch (err) {
    figma.closePlugin('✗ 出错：' + (err && err.message ? err.message : String(err)));
  }
})();

// ---------- 工具函数 ----------

function findTemplate() {
  const sel = figma.currentPage.selection;
  if (sel.length === 1 && sel[0].type === 'FRAME') {
    return { node: sel[0], source: '当前选中' };
  }
  const byId = figma.getNodeById(TEMPLATE_ID);
  if (byId && byId.type === 'FRAME') return { node: byId, source: '按 ID' };
  const byName = figma.currentPage.findOne(n => n.type === 'FRAME' && n.name === TEMPLATE_NAME);
  if (byName) return { node: byName, source: '按名称' };
  return { node: null, source: null };
}

function pickTextLayers(frame) {
  const texts = frame.findAll(n => n.type === 'TEXT');
  let song = texts.find(n => n.name === '歌曲名') || null;
  let artist = texts.find(n => n.name === '歌手名') || null;
  if (!song || !artist) {
    // 回退：字号大的当歌名，小的当歌手名
    const sorted = texts.slice().sort((a, b) => (b.fontSize || 0) - (a.fontSize || 0));
    song = song || sorted[0] || null;
    artist = artist || sorted[sorted.length - 1] || null;
  }
  return { song, artist };
}

async function loadFontsOf(node) {
  const segs = node.getStyledTextSegments(['fontName']);
  const seen = {};
  for (const s of segs) {
    const key = s.fontName.family + '|' + s.fontName.style;
    if (seen[key]) continue;
    seen[key] = true;
    await figma.loadFontAsync(s.fontName);
  }
}

function groupByBlock(data) {
  const map = [];
  const index = {};
  for (const item of data) {
    const blk = item[3] != null ? item[3] : 0;
    if (index[blk] === undefined) {
      index[blk] = map.length;
      map.push({ block: blk, items: [] });
    }
    map[index[blk]].items.push(item);
  }
  return map;
}

function fitFontSize(startSize, maxWidth, probe) {
  let size = startSize;
  const floor = Math.max(1, Math.round(startSize * CONFIG.minFontScale));
  while (size > floor) {
    size -= 1;
    probe.fontSize = size;
    if (probe.width <= maxWidth) break;
  }
  return size;
}

// 由 CONFIG.namePrefix 构建名称匹配正则（前缀做转义，避免特殊字符破坏正则）
function namePattern() {
  const escaped = CONFIG.namePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped + '\\d+-\\d+$');
}

// 删除所有本插件生成过的块（名称匹配 namePrefix + X-Y 的 FRAME）。
// 只在本会话明确设置 cleanupFirst=true 时调用。
function removeGenerated(template) {
  const re = namePattern();
  const doomed = figma.currentPage.children.filter(n =>
    n.type === 'FRAME' && n.id !== template.id && re.test(n.name)
  );
  const count = doomed.length;
  doomed.forEach(n => n.remove());
  return count;
}
