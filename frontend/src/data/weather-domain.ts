/**
 * 气象观测复核与火险重算的纯业务口径。
 * 不碰存储与页面：输入一条观测行，输出缺测/异常判定、火险等级、风险提示与核查项，
 * 换成后端时这一层可以原样搬过去。
 */

// 复核口径：四项要素任一缺测都不能直接确认，也不按前一有效值补齐（补齐会污染火险等级）。
export const WEATHER_FIELDS = ['气温', '相对湿度', '风速风向', '降水量'] as const
export type WeatherField = (typeof WEATHER_FIELDS)[number]

export const GRADE_ORDER = ['正常', '蓝色预警', '黄色预警', '橙色预警', '红色预警'] as const
export type FireGrade = (typeof GRADE_ORDER)[number]

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

/** 返回缺测要素名；空白即缺测，不做前值补齐。 */
export function missingItems(row: Record<string, unknown>): WeatherField[] {
  return WEATHER_FIELDS.filter((field) => isBlank(row[field]))
}

/** 气温 ℃：允许 -50~60，解析失败或越界视为异常。 */
export function parseTemp(value: unknown): number | null {
  if (isBlank(value)) return null
  const matched = String(value).match(/-?\d+(?:\.\d+)?/)
  if (!matched) return null
  const num = Number(matched[0])
  return Number.isFinite(num) && num >= -50 && num <= 60 ? num : null
}

/** 相对湿度 %：0~100。 */
export function parseHumidity(value: unknown): number | null {
  if (isBlank(value)) return null
  const matched = String(value).match(/\d+(?:\.\d+)?/)
  if (!matched) return null
  const num = Number(matched[0])
  return Number.isFinite(num) && num >= 0 && num <= 100 ? num : null
}

/** 降水量 mm：非负；口语"无"按 0 处理。 */
export function parsePrecip(value: unknown): number | null {
  if (isBlank(value)) return null
  if (String(value).includes('无')) return 0
  const matched = String(value).match(/\d+(?:\.\d+)?/)
  if (!matched) return null
  const num = Number(matched[0])
  return Number.isFinite(num) && num >= 0 ? num : null
}

/** 风速：兼容"东南风3级"、"3级"、"8.5m/s 西北风"，换算成 m/s 并保留风向文字。 */
export function parseWind(value: unknown): { speed: number; direction: string } | null {
  if (isBlank(value)) return null
  const text = String(value)
  const level = text.match(/(\d+(?:\.\d+)?)\s*级/)
  const meter = text.match(/(\d+(?:\.\d+)?)\s*m\s*\/\s*s/i)
  let speed: number | null = null
  if (level) {
    speed = Number(level[1]) * 2 // 蒲福风级折中的米每秒近似：1 级 ≈ 2 m/s
  } else if (meter) {
    speed = Number(meter[1])
  }
  if (speed === null || !Number.isFinite(speed) || speed < 0 || speed > 80) return null
  const direction = text.replace(/\d+(?:\.\d+)?\s*(级|m\s*\/\s*s)/gi, '').replace(/风/g, '').trim()
  return { speed, direction }
}

export type AbnormalItem = { field: WeatherField; reason: string }

/** 异常值判定：非空但解析失败或超出物理量程。缺测不算异常，走缺测口径。 */
export function abnormalItems(row: Record<string, unknown>): AbnormalItem[] {
  const result: AbnormalItem[] = []
  const temp = row['气温']
  if (!isBlank(temp) && parseTemp(temp) === null) {
    result.push({ field: '气温', reason: '气温超出 -50~60℃ 量程或无法识别' })
  }
  const humidity = row['相对湿度']
  if (!isBlank(humidity) && parseHumidity(humidity) === null) {
    result.push({ field: '相对湿度', reason: '相对湿度应在 0~100% 之间' })
  }
  const wind = row['风速风向']
  if (!isBlank(wind) && parseWind(wind) === null) {
    result.push({ field: '风速风向', reason: '风速风向无法识别（示例：东南风3级 / 8m/s）' })
  }
  const precip = row['降水量']
  if (!isBlank(precip) && parsePrecip(precip) === null) {
    result.push({ field: '降水量', reason: '降水量应为非负毫米数' })
  }
  return result
}

/**
 * 火险评分：气温越高、湿度越低、风越大、越久无雨分越高。
 * 只允许对"要素齐全"的已复核记录算分，缺测返回 null。
 */
export function fireRiskScore(row: Record<string, unknown>): number | null {
  if (missingItems(row).length > 0) return null
  const temp = parseTemp(row['气温']) as number
  const humidity = parseHumidity(row['相对湿度']) as number
  const wind = parseWind(row['风速风向']) as { speed: number; direction: string }
  const precip = parsePrecip(row['降水量']) as number

  let score = 0
  if (temp >= 30) score += 3
  else if (temp >= 27) score += 2
  else if (temp >= 20) score += 1

  if (humidity < 30) score += 3
  else if (humidity < 45) score += 2
  else if (humidity < 60) score += 1

  if (wind.speed >= 12) score += 3
  else if (wind.speed >= 8) score += 2
  else if (wind.speed >= 4) score += 1

  if (precip === 0) score += 2
  else if (precip < 1) score += 1

  return score
}

export function gradeFromScore(score: number): FireGrade {
  if (score >= 10) return '红色预警'
  if (score >= 7) return '橙色预警'
  if (score >= 4) return '黄色预警'
  if (score >= 2) return '蓝色预警'
  return '正常'
}

/** 要素不全或仍有异常值时不给等级，避免把未复核数据推到看板上。 */
export function gradeOf(row: Record<string, unknown>): FireGrade | null {
  if (missingItems(row).length > 0 || abnormalItems(row).length > 0) return null
  const score = fireRiskScore(row)
  return score === null ? null : gradeFromScore(score)
}

export function riskHint(grade: FireGrade, source?: string): string {
  const suffix = source ? `（依据${source}）` : ''
  const map: Record<FireGrade, string> = {
    正常: `低火险，按常规频次巡护${suffix}`,
    蓝色预警: `蓝色预警：关注野外用火，保持常规巡护${suffix}`,
    黄色预警: `黄色预警：加密巡护频次，严控野外用火${suffix}`,
    橙色预警: `橙色预警：重点区段双人值守，扑火队伍前置待命${suffix}`,
    红色预警: `红色预警：禁止一切野外用火，检查站升级查控，扑火队伍立即待命${suffix}`,
  }
  return map[grade]
}

/** 检查站核查清单：按等级给基础项，再叠加高温/大风/连旱的专项项。 */
export function checklistItems(grade: FireGrade, row: Record<string, unknown>): string[] {
  const base: Record<FireGrade, string[]> = {
    正常: ['常规巡查，保持检查台账完整'],
    蓝色预警: ['入山人员火种收缴与登记'],
    黄色预警: ['入山人员火种检查与实名登记', '检查防火宣传标语与告示完好'],
    橙色预警: ['入山车辆逐台登记并检查随车火种', '核查防火宣传告示完好', '确认重点路段巡护人员到岗'],
    红色预警: ['严禁一切野外用火，逐一登记入山人员', '火种全部收缴并开箱检查随车行李', '核查值守人员双岗到岗情况', '抽查巡护员加密巡护记录'],
  }
  const items = [...base[grade]]
  const temp = parseTemp(row['气温'])
  const wind = parseWind(row['风速风向'])
  const precip = parsePrecip(row['降水量'])
  if (precip === 0) items.push('天气连旱：复核站点灭火水源储备')
  if (wind !== null && wind.speed >= 8) items.push('大风提示：劝阻一切动火作业，加固宣传标牌')
  if (temp !== null && temp >= 30) items.push('高温提示：检查值守人员防暑物资与装备状态')
  return items
}

export function formatNow(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
