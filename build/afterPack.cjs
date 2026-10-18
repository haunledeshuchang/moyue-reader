/**
 * electron-builder afterPack 钩子：裁掉阅读器用不到的 Chromium 组件，给安装包减重。
 *
 * 说明：
 * - dxcompiler.dll / dxil.dll 是 Dawn(WebGPU) 的着色器编译器，本应用只用 2D 合成与分页
 *   排版，从不调用 WebGPU，删掉不影响任何现有功能（约 −27MB）。
 * - vk_swiftshader 是软件 Vulkan 后备，保留：显卡驱动异常时它负责兜底，删了有白屏风险。
 * - LICENSES.chromium.html 是 Chromium 许可证文本，法律要求随包分发，保留。
 */
const fs = require('fs');
const path = require('path');

const DROP = ['dxcompiler.dll', 'dxil.dll'];

module.exports = async function afterPack(context) {
  const dir = context.appOutDir;
  let saved = 0;
  for (const name of DROP) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      fs.rmSync(p, { force: true });
      saved += st.size;
      console.log(`[afterPack] removed ${name} (${(st.size / 1048576).toFixed(1)} MB)`);
    } catch {
      /* 文件不存在则跳过 */
    }
  }
  if (saved) console.log(`[afterPack] 共裁剪 ${(saved / 1048576).toFixed(1)} MB`);
};
