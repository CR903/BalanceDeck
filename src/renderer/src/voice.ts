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

/** 获取可用的中文语音，没有则回退到默认音色 */
export function pickVoice(lang: string = 'zh-CN'): SpeechSynthesisVoice | null {
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
    return zhVoices[0]
  }

  // 回退到默认音色
  return voices[0] || null
}

/**
 * 播报文本
 * @param text 要播报的内容
 * @param lang 语言偏好（默认中文）
 */
export function speak(text: string, lang: string = 'zh-CN'): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    console.warn('[voice] speechSynthesis 不可用')
    return
  }

  const voice = pickVoice(lang)
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
