import {
  type EntryRow,
  type ActionResult,
} from '@/data/types'
import {
  allRows,
  appendRow,
  compareAndSwapRow,
  listRows,
} from '@/data/local-store'
import {
  WEATHER_FIELDS,
  checkpointItem,
  describeFactors,
  inspectWeather,
  recalcFireLevel,
  riskHint,
  valuesFromInspection,
  type WeatherFactor,
} from '@/domain/weather'

// 气象观测的业务编排：登记/编辑限本班次，复核独立落结论；
// 复核完成后沿现有存储层把火险监测点等级、巡护风险提示、检查站核查项一起更新。

export type OperatorContext = {
  operator: string
  shiftLabel: string
}

export type WeatherForm = {
  station: string
  monitorPoint: string
  observedAt: string
  temperature: string
  humidity: string
  wind: string
  rainfall: string
}

export type ReviewPayload = {
  factors: Partial<Record<WeatherFactor, string>>
  decision: 'confirm' | 'abnormal'
  basis: string
}

export const LOCKED_STATUSES = ['已审核', '已修正']
const FIRE_STATUS_LEVEL: Record<string, string> = {
  正常: 'Ⅰ级 低',
  蓝色预警: 'Ⅱ级 较低',
  黄色预警: 'Ⅲ级 较高',
  橙色预警: 'Ⅳ级 高',
  红色预警: 'Ⅴ级 极高',
}

// 正在落结论的记录：同一时刻同一 id 只允许一个复核请求穿过，双击/并发直接拒收。
const reviewLocks = new Set<number>()

function factorText(payload: ReviewPayload, field: WeatherFactor, current: EntryRow): string {
  const next = payload.factors[field]
  return next === undefined ? String(current[field] ?? '') : next
}

function isLocked(row: EntryRow): boolean {
  return LOCKED_STATUSES.includes(String(row.status))
}

function findWeather(id: number): EntryRow | undefined {
  return listRows('weather').find((row) => Number(row.id) === id)
}

export function canEditShift(row: EntryRow, ctx: OperatorContext): boolean {
  return String(row['班次'] ?? '') === ctx.shiftLabel
}

export function nextWeatherNo(): string {
  const rows = listRows('weather')
  const max = rows.reduce((acc, row) => {
    const match = String(row['记录编号'] ?? '').match(/(\d+)$/)
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `WEAT-${String(max + 1).padStart(4, '0')}`
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 登记：观测员以本班次名义录入，采样时间必须填写（历史记录也以登记时写入的时间为准）。 */
export function registerWeather(form: WeatherForm, ctx: OperatorContext): ActionResult {
  if (form.station.trim() === '' || form.observedAt.trim() === '') {
    return { ok: false, message: '观测站点与观测时间为必填项' }
  }
  const rows = listRows('weather')
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const row: EntryRow = {
    id,
    status: '已录入',
    pending: true,
    abnormal: false,
    记录编号: nextWeatherNo(),
    [WEATHER_FIELDS.station]: form.station.trim(),
    关联监测点: form.monitorPoint.trim(),
    [WEATHER_FIELDS.observedAt]: form.observedAt.trim(),
    [WEATHER_FIELDS.temperature]: form.temperature.trim(),
    [WEATHER_FIELDS.humidity]: form.humidity.trim(),
    [WEATHER_FIELDS.wind]: form.wind.trim(),
    [WEATHER_FIELDS.rainfall]: form.rainfall.trim(),
    观测员: ctx.operator,
    班次: ctx.shiftLabel,
    记录状态: '待复核',
    复核依据: '',
    复核人: '',
    复核时间: '',
    reviewVersion: 0,
  }
  appendRow('weather', row)
  return { ok: true, message: `气象观测记录 ${String(row['记录编号'])} 已登记，等待复核` }
}

/** 观测员修改本班次记录：历史记录的采样时间锁定不可改，非本班次无权修改。 */
export function editWeather(
  id: number,
  form: WeatherForm,
  ctx: OperatorContext,
): ActionResult {
  const row = findWeather(id)
  if (!row) {
    return { ok: false, message: '没有找到该气象观测记录' }
  }
  if (isLocked(row)) {
    return { ok: false, message: '该记录已完成复核并锁定，不能再修改；如确有问题请重新登记' }
  }
  if (!canEditShift(row, ctx)) {
    return { ok: false, message: '观测员只能修改本班次记录' }
  }
  if (form.station.trim() === '') {
    return { ok: false, message: '观测站点为必填项' }
  }
  const updated = compareAndSwapRow('weather', id, row, {
    [WEATHER_FIELDS.station]: form.station.trim(),
    关联监测点: form.monitorPoint.trim(),
    // 观测时间不在编辑表单里开放：历史记录保持原采样时间。
    [WEATHER_FIELDS.temperature]: form.temperature.trim(),
    [WEATHER_FIELDS.humidity]: form.humidity.trim(),
    [WEATHER_FIELDS.wind]: form.wind.trim(),
    [WEATHER_FIELDS.rainfall]: form.rainfall.trim(),
    status: '已录入',
    pending: true,
    abnormal: false,
    记录状态: '修改后待复核',
    复核依据: '',
    复核人: '',
    复核时间: '',
  })
  if (!updated) {
    return { ok: false, message: '记录已被其他操作更新，请刷新后重试' }
  }
  return { ok: true, message: `记录 ${String(row['记录编号'])} 已修改，需重新复核` }
}

/** 标记异常（沿用现有流程）：限本班次、未锁定记录。 */
export function markWeatherAbnormal(
  id: number,
  basis: string,
  ctx: OperatorContext,
): ActionResult {
  const row = findWeather(id)
  if (!row) {
    return { ok: false, message: '没有找到该气象观测记录' }
  }
  if (isLocked(row)) {
    return { ok: false, message: '该记录已复核锁定，标记异常不能覆盖已审核结论' }
  }
  if (!canEditShift(row, ctx)) {
    return { ok: false, message: '观测员只能对本班次记录标记异常' }
  }
  if (basis.trim() === '') {
    return { ok: false, message: '标记异常需先填写异常情况说明' }
  }
  const updated = compareAndSwapRow('weather', id, row, {
    status: '异常值',
    pending: true,
    abnormal: true,
    记录状态: '异常待复核',
    复核依据: basis.trim(),
  })
  if (!updated) {
    return { ok: false, message: '记录刚被其他操作更新，请刷新后重试' }
  }
  return { ok: true, message: `记录 ${String(row['记录编号'])} 已标记异常，等待复核修正` }
}

/** 提交审核（要素齐全且合法的快速通道）：任一缺测/异常都挡下，引导走「数据复核」。 */
export function submitWeather(id: number): ActionResult {
  const row = findWeather(id)
  if (!row) {
    return { ok: false, message: '没有找到该气象观测记录' }
  }
  if (isLocked(row)) {
    return { ok: false, message: '该记录已有复核结论，重复提交不能覆盖' }
  }
  const check = inspectWeather(row, listRows('weather'))
  if (!check.canConfirm) {
    const problems = [
      ...check.missing.map((field) => `${field}缺测`),
      ...check.abnormal.map((field) => `${field}异常`),
    ].join('、')
    return {
      ok: false,
      message: `按复核口径不能直接确认：${problems}，请走「数据复核」说明修正依据`,
    }
  }
  return applyReview(id, { factors: {}, decision: 'confirm', basis: '四要素齐全且在量程内，提交审核直接确认' }, { operator: '系统', shiftLabel: '' }, { quick: true })
}

/** 把复核结论同步到关联火险监测点，并级联巡护风险提示与检查站核查项。 */
function syncLinkedModules(
  weatherRow: EntryRow,
  patch: Partial<EntryRow>,
  check: ReturnType<typeof inspectWeather>,
  decision: ReviewPayload['decision'],
  basis: string,
): void {
  const pointNo = String(patch['关联监测点'] ?? weatherRow['关联监测点'] ?? '').trim()
  const recordNo = String(weatherRow['记录编号'])
  const { values, missing } = valuesFromInspection(check)
  const level = recalcFireLevel(values, missing)

  if (pointNo !== '') {
    const point = allRows().firewatch?.find((item) => String(item['监测点编号']) === pointNo)
    if (point) {
      const source = `${recordNo} 复核结论（${basis}）`
      compareAndSwapRow('firewatch', Number(point.id), point, {
        火险等级: FIRE_STATUS_LEVEL[level.status],
        风力等级: formatFactorValue(check, WEATHER_FIELDS.wind, 'm/s'),
        相对湿度: formatFactorValue(check, WEATHER_FIELDS.humidity, '%'),
        气温读数: formatFactorValue(check, WEATHER_FIELDS.temperature, '℃'),
        监测时间: String(patch[WEATHER_FIELDS.observedAt] ?? weatherRow[WEATHER_FIELDS.observedAt]),
        数据来源: source,
        风险说明: `${riskHint(level, source)}；综合评分 ${level.score}/20`,
        status: level.status,
        pending: level.status !== '正常',
        abnormal: level.status === '红色预警',
      })
    }

    // 巡护任务按关联监测点同步风险提示（已完成/已取消任务同样更新提示，保留任务状态不变）。
    for (const patrol of [...(allRows().patrol ?? [])]) {
      if (String(patrol['关联监测点'] ?? '') !== pointNo) {
        continue
      }
      compareAndSwapRow('patrol', Number(patrol.id), patrol, {
        风险提示: riskHint(level, `${recordNo} 复核结论`),
      })
    }
  }

  // 检查站核查项：向所有未关闭站点同步生成，同一气象记录不重复入列。
  const note = decision === 'abnormal'
    ? basis
    : missing.length > 0
      ? `${missing.join('、')}按缺测保留（保守口径重算）`
      : '四要素复核齐全'
  const item = checkpointItem(recordNo, decision === 'abnormal' ? 'abnormal' : 'confirmed', decision === 'abnormal' ? null : level, note)
  for (const station of [...(allRows().checkpoint ?? [])]) {
    if (String(station.status) === '临时关闭') {
      continue
    }
    const existing = String(station['检查项目'] ?? '')
    if (existing.includes(recordNo)) {
      continue
    }
    const items = [item, ...existing.split(/[；;]/).map((s) => s.trim()).filter(Boolean)]
      .slice(0, 6)
    compareAndSwapRow('checkpoint', Number(station.id), station, {
      检查项目: items.join('；'),
    })
  }
}

function formatFactorValue(
  check: ReturnType<typeof inspectWeather>,
  field: WeatherFactor,
  unit: string,
): string {
  const factor = check.factors.find((item) => item.field === field)
  if (!factor || factor.state === 'missing') {
    return '缺测'
  }
  if (typeof factor.value !== 'number') {
    return factor.raw
  }
  return field === WEATHER_FIELDS.wind ? `${factor.raw}（约${factor.value}m/s）` : `${factor.value}${unit}`
}

/** 复核落结论：CAS + 行锁 + 终态校验，重复/并发提交只落第一份。 */
export function applyReview(
  id: number,
  payload: ReviewPayload,
  ctx: OperatorContext,
  options: { quick?: boolean } = {},
): ActionResult {
  const row = findWeather(id)
  if (!row) {
    return { ok: false, message: '没有找到该气象观测记录' }
  }
  if (isLocked(row)) {
    return {
      ok: false,
      message: `该记录已由 ${String(row['复核人'])} 于 ${String(row['复核时间'])} 完成复核，重复提交不得覆盖已审核结论`,
    }
  }
  if (reviewLocks.has(id)) {
    return { ok: false, message: '该记录正在复核落结论，请勿重复提交' }
  }
  if (payload.basis.trim() === '') {
    return { ok: false, message: '请填写复核依据（修正/补录值的来源或维持缺测的说明）' }
  }

  reviewLocks.add(id)
  try {
    const merged: EntryRow = { ...row }
    for (const field of Object.keys(payload.factors) as WeatherFactor[]) {
      const text = payload.factors[field]
      if (text !== undefined) {
        merged[field] = text
      }
    }
    const check = inspectWeather(merged, listRows('weather'))

    // 直接确认结论要求四要素齐全合法；仍带缺测/异常只能维持异常或补正后再确认。
    if (payload.decision === 'confirm' && !check.canConfirm) {
      const problems = [
        ...check.missing.map((field) => `${field}缺测`),
        ...check.abnormal.map((field) => `${field}异常`),
      ].join('、')
      return {
        ok: false,
        message: `确认数据未通过复核口径：${problems}；请补录并注明依据，或维持「异常值」结论`,
      }
    }

    const changed = (Object.keys(payload.factors) as WeatherFactor[]).some(
      (field) => payload.factors[field] !== undefined && payload.factors[field] !== String(row[field] ?? ''),
    )
    const status = payload.decision === 'abnormal'
      ? '异常值'
      : changed ? '已修正' : '已审核'
    const patch: Partial<EntryRow> = {
      ...Object.fromEntries(
        (Object.keys(payload.factors) as WeatherFactor[])
          .filter((field) => payload.factors[field] !== undefined)
          .map((field) => [field, payload.factors[field] ?? '']),
      ),
      status,
      pending: false,
      abnormal: payload.decision === 'abnormal',
      记录状态: status === '异常值'
        ? `异常已记录：${describeFactors(check)}`
        : `${changed ? '修正' : '复核'}完成：${describeFactors(check)}`,
      复核依据: payload.basis.trim(),
      复核人: options.quick ? (ctx.operator || '系统') : ctx.operator,
      复核时间: nowText(),
    }

    const updated = compareAndSwapRow('weather', id, row, patch)
    if (!updated) {
      return { ok: false, message: '并发冲突：该记录已被其他复核落结论，本次提交未生效' }
    }
    syncLinkedModules(updated, patch, check, payload.decision, payload.basis.trim())
    return {
      ok: true,
      message: `记录 ${String(row['记录编号'])} 复核结论「${status}」已落地，关联火险等级与巡护提示已同步`,
    }
  } finally {
    reviewLocks.delete(id)
  }
}

/** 火险预警看板手动重算：按监测点关联的最近一条已复核气象记录重算（复核时已自动触发，这里用于兜底）。 */
export function recalcPointFromLatest(pointNo: string): ActionResult {
  const point = listRows('firewatch').find((item) => String(item['监测点编号']) === pointNo)
  if (!point) {
    return { ok: false, message: '没有找到该火险监测点' }
  }
  const latest = listRows('weather')
    .filter((item) => String(item['关联监测点'] ?? '') === pointNo && isLocked(item))
    .sort((a, b) => String(b['观测时间']).localeCompare(String(a['观测时间'])))[0]
  if (!latest) {
    return { ok: false, message: '该监测点还没有复核完成的气象记录，无法重算' }
  }
  const check = inspectWeather(latest, listRows('weather'))
  const { values, missing } = valuesFromInspection(check)
  const level = recalcFireLevel(values, missing)
  const source = `${String(latest['记录编号'])} 复核结论（${String(latest['复核依据'])}）`
  const updated = compareAndSwapRow('firewatch', Number(point.id), point, {
    火险等级: FIRE_STATUS_LEVEL[level.status],
    风力等级: formatFactorValue(check, WEATHER_FIELDS.wind, 'm/s'),
    相对湿度: formatFactorValue(check, WEATHER_FIELDS.humidity, '%'),
    气温读数: formatFactorValue(check, WEATHER_FIELDS.temperature, '℃'),
    监测时间: String(latest['观测时间']),
    数据来源: source,
    风险说明: `${riskHint(level, source)}；综合评分 ${level.score}/20`,
    status: level.status,
    pending: level.status !== '正常',
    abnormal: level.status === '红色预警',
  })
  if (!updated) {
    return { ok: false, message: '监测点刚被其他复核更新，请刷新看板' }
  }
  for (const patrol of [...(allRows().patrol ?? [])]) {
    if (String(patrol['关联监测点'] ?? '') !== pointNo) {
      continue
    }
    compareAndSwapRow('patrol', Number(patrol.id), patrol, {
      风险提示: riskHint(level, `${String(latest['记录编号'])} 复核结论`),
    })
  }
  return { ok: true, message: `监测点 ${pointNo} 已按 ${String(latest['记录编号'])} 重算为「${level.status}」` }
}
