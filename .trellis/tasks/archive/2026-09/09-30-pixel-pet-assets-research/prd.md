# 调研免费像素宠物/玩偶素材（替代 3D 真人瘦身）

## Goal

用 `sn-search-code`（GitHub 搜索 + GitHub API 核验）+ 网页搜索，查找可**免费使用**的像素宠物 / 玩偶形象素材（含可通过平台自动生成的接口 / 工具），评估替代 Rocketbox 3D 真人素材给 BalanceDeck 瘦身的可行性。

## Background

- BalanceDeck 当前「个性人物」形态使用 Microsoft Rocketbox 真人模型（每人 1 个模型 + 11 条动作，随包分发，体积较大，且需要 three.js / WebGL）。
- 用户希望**去掉真人数字人等 3D 相关素材**给软件瘦身，改用免费像素宠物 / 玩偶形象（或平台自动生成接口）。
- 默认 2D 圆环形态已不加载 three.js；本调研服务于后续「素材瘦身」实现任务。

## Requirements

1. **检索方向**（至少覆盖 3 个）：
   - 免费像素宠物 / 玩偶精灵图（sprite sheet）、像素风动画素材
   - 免费 2D/3D 角色生成接口或平台（如通过 API 自动生成形象）
   - 开源桌宠 / 虚拟形象项目可复用的素材与动作
   - Live2D / Spine / 骨骼动画免费素材
2. 每个候选需注明：
   - 来源（GitHub 仓库 / 网站链接）
   - 许可协议（MIT / CC0 / CC-BY / Apache 等；不可商用的要特别标注）
   - 格式（png / sprite sheet / glb / JSON / Live2D 模型等）
   - 是否支持动作 / 动画
   - 是否可离线随包分发（不依赖联网 CDN）
3. 输出调研报告到本任务 `research/` 目录。
4. 给出**替代可行性结论**：能否替代 Rocketbox 真人数字人；对包体 / 启动 / 显存的影响；推荐 1-2 个方案及理由。

## Acceptance Criteria

- [ ] 报告为中文 Markdown，写入 `research/report.md`
- [ ] 报告包含不少于 8 个候选素材源 / 接口
- [ ] 每个候选有来源链接、许可协议、格式、动画支持说明
- [ ] 报告包含替代可行性结论与推荐方案（1-2 个）
- [ ] 结论摘要回填到本 prd.md 的 Notes

## Notes

- 纯调研任务，不涉及代码修改。
- 调研方法：`sn-search-code` 的 GitHub 搜索脚本 + GitHub API 元数据核验 + 网页搜索交叉验证。
- 若脚本缺依赖，按技能说明安装到虚拟环境（`/tmp/snsearch-venv`）。

## 调研结论摘要（2026-09-30，详见 `research/report.md`）

- **候选总数**：17 个（像素精灵图 4 类 / 生成接口 4 个 / 桌宠项目 5 个 / 骨骼动画 2 类 / 3D 轻量替代 2 个）。
- **可行性**：完全可行。3D 真人形态本为可选项（默认 2D 圆环不加载 three.js），现有动作编排逻辑（gesture.ts / clips.ts）与 three.js 解耦，可平移给 2D 精灵动画。Live2D/Spine 免费素材普遍「禁止再分发」，不适合随包分发。
- **包体现状**：`resources/human-pets` 实测 **221MB**（aria 94MB + ray 96MB + reyna-pilot 31MB；纹理 TGA/PNG 双份为大头），另加 three.js 运行时依赖。
- **推荐方案一（首选）**：纯 2D 像素宠物 —— Kenney（CC0）精灵表或 TermiPet（Apache-2.0）的 `spritesheet.webp + pet.json` 组织方式（1.7MB/只），配合 DiceBear pixel-art 风格（CC0）做形象自动生成；彻底移除 three.js，包体 −220MB、显存 0 占用。
- **推荐方案二（备选）**：若保留 3D，用 Kenney Cube Pets（CC0，16 只低模 GLB + 动画，数 MB）替代 Rocketbox，素材 221MB → 数 MB，许可更宽松。