// ═══════════════════════════════════════════════════════════════════════════════
// TTS 音色 / 语音风格清单
//
// 纯数据（无 electron / React 依赖），渲染层下拉、speechOut 的出厂默认值与单元测试
// 共用同一份 —— 抄一份进组件就会漂（quality-guidelines「常量只放一个家」）。
//
// 来源：https://voice.mytts.ccwu.cc 页面上「语音选择」「语音风格」两个 <select> 的
// 逐条 option（2026-09-29 抓取）。**照抄，不臆造** —— 服务端不认的名字写进来等于给用户
// 一个发不出声的选项。「语音风格」过去是被 `requestAudioBlob` 写死的 'general'，
// 用户在服务页面能选 11 种、我们这边一个都发不出去；style 确实会被服务端接受
// （实测 cheerful → HTTP 200 / 1.13s / 12528B 有效 MP3），所以它是一等配置。
// ═══════════════════════════════════════════════════════════════════════════════

export interface TtsVoice {
  /** 发给服务的 voice 值（zh-CN-…Neural） */
  id: string
  /** 服务页面上的显示名（含「女声·温柔」这类标注） */
  label: string
  /**
   * 页面标注的性别。**只用于下拉按性别分组**，不参与系统语音的性别判断 ——
   * 那是 voice.ts 的职责，它判断的是**系统**音色列表，两者不是同一张表。
   */
  gender: 'female' | 'male'
  /** 页面标注的性格 */
  trait: string
}

export interface TtsStyle {
  id: string
  label: string
}

// ⚠ gender 一律**照抄服务页面的标注**，不在这里用关键词重新推断。
//   已知的一处存疑：云夏（zh-CN-YunxiaNeural）被页面标成「男声·热情」，而微软自己的
//   音色表把 Yunxia 列为女声 —— 也就是说这 8 个「男声」里可能有 1 个标错了。
//   照抄的理由：本字段只决定下拉里的分组，用户按下拉里的文字就能对上服务页面；
//   而系统语音性别走的是 petGender（助理身份），两者互不相干。
//   改这条数据前先看上面这段，别顺手「修正」成你以为的样子。
export const TTS_VOICES: TtsVoice[] = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女声·温柔）', gender: 'female', trait: '温柔' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女声·甜美）', gender: 'female', trait: '甜美' },
  { id: 'zh-CN-XiaochenNeural', label: '晓辰（女声·知性）', gender: 'female', trait: '知性' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵（女声·优雅）', gender: 'female', trait: '优雅' },
  { id: 'zh-CN-XiaomengNeural', label: '晓梦（女声·梦幻）', gender: 'female', trait: '梦幻' },
  { id: 'zh-CN-XiaomoNeural', label: '晓墨（女声·文艺）', gender: 'female', trait: '文艺' },
  { id: 'zh-CN-XiaoqiuNeural', label: '晓秋（女声·成熟）', gender: 'female', trait: '成熟' },
  { id: 'zh-CN-XiaoruiNeural', label: '晓睿（女声·智慧）', gender: 'female', trait: '智慧' },
  { id: 'zh-CN-XiaoshuangNeural', label: '晓双（女声·活泼）', gender: 'female', trait: '活泼' },
  { id: 'zh-CN-XiaoxuanNeural', label: '晓萱（女声·清新）', gender: 'female', trait: '清新' },
  { id: 'zh-CN-XiaoyanNeural', label: '晓颜（女声·柔美）', gender: 'female', trait: '柔美' },
  { id: 'zh-CN-XiaoyouNeural', label: '晓悠（女声·悠扬）', gender: 'female', trait: '悠扬' },
  { id: 'zh-CN-XiaozhenNeural', label: '晓甄（女声·端庄）', gender: 'female', trait: '端庄' },
  { id: 'zh-CN-YunxiNeural', label: '云希（男声·清朗）', gender: 'male', trait: '清朗' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（男声·阳光）', gender: 'male', trait: '阳光' },
  { id: 'zh-CN-YunjianNeural', label: '云健（男声·稳重）', gender: 'male', trait: '稳重' },
  { id: 'zh-CN-YunfengNeural', label: '云枫（男声·磁性）', gender: 'male', trait: '磁性' },
  { id: 'zh-CN-YunhaoNeural', label: '云皓（男声·豪迈）', gender: 'male', trait: '豪迈' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏（男声·热情）', gender: 'male', trait: '热情' },
  { id: 'zh-CN-YunyeNeural', label: '云野（男声·野性）', gender: 'male', trait: '野性' },
  { id: 'zh-CN-YunzeNeural', label: '云泽（男声·深沉）', gender: 'male', trait: '深沉' }
]

export const TTS_STYLES: TtsStyle[] = [
  { id: 'general', label: '通用' },
  { id: 'assistant', label: '智能助手' },
  { id: 'chat', label: '聊天对话' },
  { id: 'customerservice', label: '客服专业' },
  { id: 'newscast', label: '新闻播报' },
  { id: 'affectionate', label: '亲切温暖' },
  { id: 'calm', label: '平静舒缓' },
  { id: 'cheerful', label: '愉快欢乐' },
  { id: 'gentle', label: '温和柔美' },
  { id: 'lyrical', label: '抒情诗意' },
  { id: 'serious', label: '严肃正式' }
]

/**
 * 出厂默认音色与风格。
 *
 * 为什么单独立成常量：旧版本里同一个字符串在 speechOut 的 DEFAULT_TTS_CONFIG 与
 * VoiceReminderSection 的预设表各写一份，并在两边都留了「必须保持一致」的注释 ——
 * 那不是机制，是许愿。改成同一个来源之后，两边不可能再漂。
 */
export const DEFAULT_TTS_VOICE = 'zh-CN-YunxiNeural'
export const DEFAULT_TTS_STYLE = 'general'
