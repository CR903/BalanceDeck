/**
 * 系统语音播报模块（R12-R16）
 * 使用 window.speechSynthesis 播报焦点供应商的余额与用量
 */

/** 停止当前播报 */
export function stopVoice(): void {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel()
  }
}

/**
 * 判断音色性别。
 * macOS 中文音色命名规律：Ting-Ting（女）、Li-Mu（男）、Sin-Ji（女）、Mei-Jia（女）等。
 * 通过名字里的关键词判断，不依赖具体系统版本。
 */
function voiceGender(voice: SpeechSynthesisVoice): 'female' | 'male' | 'unknown' {
  const name = voice.name.toLowerCase()
  // 女声关键词
  if (name.includes('ting') || name.includes('mei') || name.includes('sin') || name.includes('female') || name.includes('女')) {
    return 'female'
  }
  // 男声关键词
  if (name.includes('mu') || name.includes('male') || name.includes('男')) {
    return 'male'
  }
  return 'unknown'
}

/** 获取可用的中文语音，没有则回退到默认音色。gender: 'female' | 'male' | 'any' */
export function pickVoice(lang: string = 'zh-CN', gender: 'female' | 'male' | 'any' = 'any'): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return null
  }

  const voices = window.speechSynthesis.getVoices()
  if (voices.length === 0) {
    // 某些浏览器需要等待 voiceschanged 事件
    return null
  }

  // 优先选择中文音色
  const zhVoices = voices.filter((v) => v.lang.startsWith('zh'))
  if (zhVoices.length > 0) {
    if (gender === 'any') {
      return zhVoices[0]
    }
    // 按性别筛选
    const matched = zhVoices.find((v) => voiceGender(v) === gender)
    if (matched) {
      return matched
    }
    // 找不到匹配性别的音色，回退到第一个中文音色
    return zhVoices[0]
  }

  // 回退到默认音色
  return voices[0] || null
}

/**
 * 播报文本
 * @param text 要播报的内容
 * @param lang 语言偏好（默认中文）
 * @param gender 音色性别偏好（默认不限制）
 */
export function speak(text: string, lang: string = 'zh-CN', gender: 'female' | 'male' | 'any' = 'any'): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    console.warn('[voice] speechSynthesis 不可用')
    return
  }

  const voice = pickVoice(lang, gender)
  if (!voice) {
    console.warn('[voice] 无可用语音')
    return
  }

  const utterance = new SpeechSynthesisUtterance(text)
  utterance.voice = voice
  utterance.rate = 1.0
  utterance.pitch = 1.0
  utterance.volume = 1.0

  window.speechSynthesis.speak(utterance)
  console.log('[voice] 已播报:', text)
}
