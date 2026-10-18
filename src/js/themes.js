/**
 * 墨阅 MoYue — 主题系统
 * 三种纸面主题：日间（暖白）/ 夜间（深灰）/ 护眼（淡绿）
 * 通过 CSS 变量作用于应用界面与阅读区域
 */

export const THEMES = {
  day: {
    key: 'day', name: '日间', icon: '☀',
    vars: {
      '--bg': '#f5f3ee', '--surface': '#faf9f6', '--surface-2': '#efede6',
      '--text': '#2c2c2a', '--text-2': '#75736b', '--text-3': '#a3a099',
      '--border': 'rgba(44,44,42,.12)', '--border-strong': 'rgba(44,44,42,.22)',
      '--accent': '#0f6e56', '--accent-soft': '#e1f5ee', '--accent-text': '#ffffff',
      '--reader-bg': '#faf9f6', '--reader-text': '#2c2c2a',
      '--shadow': '0 1px 3px rgba(44,44,42,.08), 0 4px 14px rgba(44,44,42,.05)',
      '--hover': 'rgba(44,44,42,.05)',
    },
  },
  night: {
    key: 'night', name: '夜间', icon: '☾',
    vars: {
      '--bg': '#191817', '--surface': '#242322', '--surface-2': '#2d2b29',
      '--text': '#d6d4cc', '--text-2': '#948f86', '--text-3': '#6b675f',
      '--border': 'rgba(255,255,255,.1)', '--border-strong': 'rgba(255,255,255,.2)',
      '--accent': '#5dcaa5', '--accent-soft': 'rgba(93,202,165,.15)', '--accent-text': '#0c2b22',
      '--reader-bg': '#201f1d', '--reader-text': '#cfcdc4',
      '--shadow': '0 1px 3px rgba(0,0,0,.3)',
      '--hover': 'rgba(255,255,255,.06)',
    },
  },
  eye: {
    key: 'eye', name: '护眼', icon: '❧',
    vars: {
      '--bg': '#b9e4c4', '--surface': '#c7edcc', '--surface-2': '#d3efd7',
      '--text': '#26402c', '--text-2': '#4d6353', '--text-3': '#7d947f',
      '--border': 'rgba(38,64,44,.16)', '--border-strong': 'rgba(38,64,44,.3)',
      '--accent': '#2e7d4f', '--accent-soft': 'rgba(46,125,79,.14)', '--accent-text': '#ffffff',
      '--reader-bg': '#c7edcc', '--reader-text': '#2e4a32',
      '--shadow': '0 1px 3px rgba(38,64,44,.12)',
      '--hover': 'rgba(38,64,44,.07)',
    },
  },
};

export const THEME_ORDER = ['day', 'night', 'eye'];

export function applyTheme(key) {
  const theme = THEMES[key] || THEMES.day;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  root.dataset.theme = theme.key;
  return theme;
}

export function nextTheme(current) {
  const i = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length];
}

/** 阅读版式设置（作用于文本渲染与 epub 主题注入） */
export const FONT_FAMILIES = {
  system: 'system-ui, "Microsoft YaHei", "PingFang SC", sans-serif',
  song: '"Noto Serif CJK SC", "Source Han Serif SC", "SimSun", "宋体", serif',
  hei: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
  kai: '"KaiTi", "楷体", "STKaiti", "Noto Serif CJK SC", serif',
  // 西文衬线（Times New Roman）：拉丁字符优先使用，中文字符自动回退到系统衬线
  times: '"Times New Roman", "NSimSun", "SimSun", "宋体", serif',
};

export function readingStyles(s) {
  return {
    fontSize: s.fontSize, lineHeight: s.lineHeight,
    fontFamily: FONT_FAMILIES[s.fontFamily] || FONT_FAMILIES.system,
    margin: s.margin,
  };
}
