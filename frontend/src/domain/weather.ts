import type { EntryRow } from '@/data/types'

// 气象观测复核口径：气温、相对湿度、风速风向、降水量四个要素缺一不可直接确认，
// 异常值或补录值必须在复核面板里写明修正依据。逻辑独立成纯函数，视图与本地服务共用。

export const WEATHER_FIELDS = {
  station: '观测站点',
  observedAt: '观测时间',
  temperature: '气温',
  humidity: '相对湿度',
  wind: '风速风向',
  rainfall: '降水量',
} as const

export const WEATHER_REQUIRED_FACTORS = [
  WEATHER_FIELDS.temperature,
  WEATHER_FIELDS.humidity,
  WEATHER_FIELDS.wind,
  WEATHER_FIELDS.rainfall,
] as const

export type WeatherFactor = (typeof WEATHER_REQUIRED_FACTORS)[number]

// 各要素允许量程：超出即判定异常，需要复核员说明修正依据。
const TEMPERATURE_RANGE: [number, number] = [-50, 60]
const HUMIDITY_RANGE: [number, number] = [0, 100]
const WIND_SPEED_RANGE: [number, number] = [0, 60]
const RAINFALL_RANGE: [number, number] = [0, 400]

// 蒲福风级换算（m/s），支持「X级」这类原始记录。
const BEAUFORT_TABLE: Record<number, number> = {
  0: 0, 1: 1, 2: 2, 3: 4, 4: 7, 5: 9, 6: 12, 7: 16,
  8: 19, 9: 23, 10: 27, 11: 32, 12: 35,
}

const WIND_DIRECTIONS = ['北', '南', '东', '西', '东北', '西北', '东南', '西南']

export type FactorState = 'ok' | 'missing' | 'abnormal'

export type FactorCheck = {
  field: WeatherFactor
  state: FactorState
  raw: string
  value?: number
  reason?: string
}

export type WeatherCheck = {
  factors: FactorCheck[]
  missing: WeatherFactor[]
  abnormal: WeatherFactor[]
  canConfirm: boolean
  previousValid: Partial<Record<WeatherFactor, string>>
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

function numericFactor(raw: string, range: [number, number], unit: string): FactorCheck {
  const text = raw.trim()
  if (text === '') {
    return { field: WEATHER_FIELDS.temperature, state: 'missing', raw }
  }
  // 允许纯数字或带单位后缀（如 26.5℃、65%、2.1mm），其余写法视为格式异常。
  const match = text.match(/^(-?\d+(?:\.\d+)?)\s*[^\d.-]*$/)
  if (!match) {
    return { field: WEATHER_FIELDS.temperature, state: 'abnormal', raw, reason: '不是可识别的数值' }
  }
  const value = Number(match[1])
  if (Number.isNaN(value)) {
    return { field: WEATHER_FIELDS.temperature, state: 'abnormal', raw, reason: '不是可识别的数值' }
  }
  if (value < range[0] || value > range[1]) {
    return {
      field: WEATHER_FIELDS.temperature,
      state: 'abnormal',
      raw,
      value,
      reason: `超出合理量程 ${range[0]}${unit}~${range[1]}${unit}`,
    }
  }
  return { field: WEATHER_FIELDS.temperature, state: 'ok', raw, value }
}

/** 解析风速风向文本：需同时给出风向与风速/风力等级，缺风向或风速按缺测，风速超量程按异常。 */
export function parseWind(raw: string): { state: FactorState; speedMs?: number; reason?: string } {
  const text = raw.trim()
  if (text === '') {
    return { state: 'missing' }
  }
  const hasDirection = WIND_DIRECTIONS.some((dir) => text.includes(dir))
  const forceMatch = text.match(/(\d+(?:\.\d+)?)\s*级/)
  const speedMatch = forceMatch
    ? null
    : text.match(/(\d+(?:\.\d+)?)\s*(?:m\/s|米每秒|米\/秒|ms)?/i)
  let speed: number | undefined
  if (forceMatch) {
    const level = Number(forceMatch[1])
    speed = BEAUFORT_TABLE[level]
    if (speed === undefined) {
      return { state: 'abnormal', reason: `风力等级 ${level} 级超出蒲福风级表` }
    }
  } else if (speedMatch) {
    speed = Number(speedMatch[1])
  } else {
    return { state: 'missing', reason: '缺少可识别的风速或风力等级' }
  }
  if (!hasDirection) {
    return { state: 'missing', reason: '缺少风向', speedMs: speed }
  }
  if (speed === undefined || Number.isNaN(speed)) {
    return { state: 'missing' }
  }
  if (speed < WIND_SPEED_RANGE[0] || speed > WIND_SPEED_RANGE[1]) {
    return { state: 'abnormal', reason: `风速 ${speed}m/s 超出合理量程`, speedMs: speed }
  }
  return { state: 'ok', speedMs: speed }
}

function checkFactor(field: WeatherFactor, raw: string): FactorCheck {
  switch (field) {
    case WEATHER_FIELDS.temperature:
      return { ...numericFactor(raw, TEMPERATURE_RANGE, '℃'), field }
    case WEATHER_FIELDS.humidity:
      return { ...numericFactor(raw, HUMIDITY_RANGE, '%'), field }
    case WEATHER_FIELDS.rainfall:
      return { ...numericFactor(raw, RAINFALL_RANGE, 'mm'), field }
    case WEATHER_FIELDS.wind: {
      if (isBlank(raw)) {
        return { field, state: 'missing', raw: raw ?? '' }
      }
      const wind = parseWind(raw)
      return {
        field,
        state: wind.state,
        raw,
        value: wind.speedMs,
        reason: wind.reason,
      }
    }
  }
}

/** 取同一观测站点、观测时间更早的最近一条可直接引用（本要素状态正常）的历史读数。 */
export function previousValidValues(
  rows: EntryRow[],
  row: EntryRow,
): Partial<Record<WeatherFactor, string>> {
  const station = String(row[WEATHER_FIELDS.station] ?? '')
  const observedAt = String(row[WEATHER_FIELDS.observedAt] ?? '')
  const earlier = rows
    .filter(
      (item) =>
        item.id !== row.id &&
        String(item[WEATHER_FIELDS.station] ?? '') === station &&
        String(item[WEATHER_FIELDS.observedAt] ?? '') < observedAt,
    )
    .sort(
      (a, b) =>
        String(b[WEATHER_FIELDS.observedAt] ?? '').localeCompare(
          String(a[WEATHER_FIELDS.observedAt] ?? ''),
        ),
    )
  const result: Partial<Record<WeatherFactor, string>> = {}
  for (const field of WEATHER_REQUIRED_FACTORS) {
    for (const item of earlier) {
      const check = checkFactor(field, String(item[field] ?? ''))
      if (check.state === 'ok') {
        result[field] = String(item[field])
        break
      }
    }
  }
  return result
}

/** 按复核口径检查一条气象记录：返回各要素状态、缺测/异常清单与前一有效时次参考。 */
export function inspectWeather(row: EntryRow, history: EntryRow[]): WeatherCheck {
  const factors = WEATHER_REQUIRED_FACTORS.map((field) =>
    checkFactor(field, String(row[field] ?? '')),
  )
  const missing = factors.filter((item) => item.state === 'missing').map((item) => item.field)
  const abnormal = factors.filter((item) => item.state === 'abnormal').map((item) => item.field)
  return {
    factors,
    missing,
    abnormal,
    canConfirm: missing.length === 0 && abnormal.length === 0,
    previousValid: previousValidValues(history, row),
  }
}

export type FireLevel = {
  score: number
  status: '正常' | '蓝色预警' | '黄色预警' | '橙色预警' | '红色预警'
  conservative: boolean
}

// 火险评分：气温、湿度、风、降水各按区间取 1~5 分；缺测要素没有真实读数可依，
// 按「就高不就低」的保守口径取高分档，避免缺测把等级压低。
function scoreTemperature(value: number | undefined): number {
  if (value === undefined) return 5
  if (value >= 35) return 5
  if (value >= 28) return 4
  if (value >= 15) return 3
  if (value >= 5) return 2
  return 1
}

function scoreHumidity(value: number | undefined): number {
  if (value === undefined) return 5
  if (value < 25) return 5
  if (value < 40) return 4
  if (value < 60) return 3
  if (value < 80) return 2
  return 1
}

function scoreWind(speedMs: number | undefined): number {
  if (speedMs === undefined) return 5
  if (speedMs >= 17) return 5
  if (speedMs >= 12) return 4
  if (speedMs >= 7) return 3
  if (speedMs >= 2) return 2
  return 1
}

function scoreRainfall(value: number | undefined): number {
  if (value === undefined) return 5
  if (value === 0) return 5
  if (value < 1) return 4
  if (value < 5) return 3
  if (value < 10) return 2
  return 1
}

/** 依据复核结论重算火险等级；入参用缺测映射表达仍缺测的要素。 */
export function recalcFireLevel(
  values: Partial<Record<WeatherFactor, number>>,
  missing: WeatherFactor[],
): FireLevel {
  const miss = new Set(missing)
  const t = miss.has(WEATHER_FIELDS.temperature) ? undefined : values[WEATHER_FIELDS.temperature]
  const h = miss.has(WEATHER_FIELDS.humidity) ? undefined : values[WEATHER_FIELDS.humidity]
  const w = miss.has(WEATHER_FIELDS.wind) ? undefined : values[WEATHER_FIELDS.wind]
  const r = miss.has(WEATHER_FIELDS.rainfall) ? undefined : values[WEATHER_FIELDS.rainfall]
  const score =
    scoreTemperature(t) + scoreHumidity(h) + scoreWind(w) + scoreRainfall(r)
  let status: FireLevel['status']
  if (score >= 18) status = '红色预警'
  else if (score >= 14) status = '橙色预警'
  else if (score >= 10) status = '黄色预警'
  else if (score >= 6) status = '蓝色预警'
  else status = '正常'
  return { score, status, conservative: miss.size > 0 }
}

/** 复核后按当前各要素值重新解析数值，仍缺测的要素进入 missing。 */
export function valuesFromInspection(check: WeatherCheck): {
  values: Partial<Record<WeatherFactor, number>>
  missing: WeatherFactor[]
} {
  const values: Partial<Record<WeatherFactor, number>> = {}
  const missing: WeatherFactor[] = []
  for (const factor of check.factors) {
    if (factor.state === 'missing') {
      missing.push(factor.field)
    } else if (typeof factor.value === 'number') {
      values[factor.field] = factor.value
    }
  }
  return { values, missing }
}

export function describeFactors(check: WeatherCheck): string {
  return check.factors
    .map((factor) =>
      factor.state === 'missing'
        ? `${factor.field.replace(/^(气温|相对湿度|风速风向|降水量)$/, (m) => m)}缺测`
        : factor.state === 'abnormal'
          ? `${factor.field}异常`
          : `${factor.field} ${factor.raw}`,
    )
    .join('；')
}

export function riskHint(level: FireLevel, source: string): string {
  const base = {
    正常: '常规巡护，注意野外用火检查',
    蓝色预警: '蓝色火险：加强巡护频次，留意烟点',
    黄色预警: '黄色火险：重点区域加密巡护，严控火源',
    橙色预警: '橙色火险：重点区段蹲守，扑火队伍待命',
    红色预警: '红色火险：封山管控，全员靠前驻防',
  }[level.status]
  const suffix = level.conservative ? '（含缺测要素，按保守口径评估）' : ''
  return `${base}${suffix}；依据${source}`
}

export function checkpointItem(
  recordNo: string,
  status: 'confirmed' | 'abnormal',
  level: FireLevel | null,
  note: string,
): string {
  if (status === 'abnormal' || level === null) {
    return `气象复核核查：${recordNo} 存在缺测/异常要素（${note}），核查入山火种与巡防部署`
  }
  return `气象复核核查：${recordNo} 复核完成，当前${level.status}，核查入山火种与巡防部署`
}
