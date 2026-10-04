/**
 * 气象观测复核工作流：登记、本班次修正、标记异常、复核确认。
 *
 * 口径：
 * - 缺测保留空白，不按前值补齐；气温/相对湿度/风速风向/降水量任一缺测不能确认。
 * - 观测员只能改本班次记录；历史记录观测时间不动。
 * - 复核确认只落一份结论：锁版本校验防并发，重复提交不覆盖已审核结论。
 * - 复核通过后按气象→火险现有调用链，同步重算火险监测点、巡护风险提示、检查站核查清单。
 */

import { listRows, saveRows } from '@/data/local-store'
import {
  GRADE_ORDER,
  abnormalItems,
  checklistItems,
  formatNow,
  gradeOf,
  isBlank,
  missingItems,
  riskHint,
  type FireGrade,
} from '@/data/weather-domain'
import type { ActionResult, EntryRow } from '@/data/types'

const KEY = 'weather'
const LOCKED_STATUSES = ['已审核', '已修正']

export type WeatherForm = {
  观测站点: string
  观测时间: string
  气温: string
  相对湿度: string
  风速风向: string
  降水量: string
}

export type ReviewContext = {
  operator: string
  shiftLabel: string
  /** 打开复核窗口时读到的锁版本，提交时必须还相同，否则视为并发审核。 */
  expectedLockVersion: number
  remark: string
}

export type WeatherReviewDetail = {
  id: number
  missing: string[]
  abnormals: { field: string; reason: string }[]
  grade: FireGrade | null
  lockVersion: number
  locked: boolean
}

function getRow(id: number): EntryRow | undefined {
  return listRows(KEY).find((row) => Number(row.id) === id)
}

function persist(rows: EntryRow[]): void {
  saveRows(KEY, rows)
}

export function isLocked(row: EntryRow | undefined): boolean {
  return !!row && LOCKED_STATUSES.includes(String(row.status)) && !isBlank(row['复核人'])
}

/** 观测员改数权限：只允许改本班次且未锁定的记录。 */
export function canObserverEdit(row: EntryRow | undefined, shiftLabel: string): boolean {
  if (!row || isLocked(row)) return false
  return String(row['班次'] ?? '') === shiftLabel
}

export function weatherDetail(row: EntryRow): WeatherReviewDetail {
  const rec = row as unknown as Record<string, unknown>
  const grade = gradeOf(rec)
  return {
    id: Number(row.id),
    missing: missingItems(rec),
    abnormals: abnormalItems(rec),
    grade,
    lockVersion: Number(row['lockVersion'] ?? 0),
    locked: isLocked(row),
  }
}

export function createWeatherRecord(form: WeatherForm, operator: string, shiftLabel: string): ActionResult {
  if (isBlank(form.观测站点.trim())) return { ok: false, message: '观测站点不能为空' }
  if (isBlank(form.观测时间.trim())) return { ok: false, message: '观测时间不能为空' }
  const rows = listRows(KEY)
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const now = formatNow()
  const row: EntryRow = {
    id,
    status: '已录入',
    pending: true,
    abnormal: false,
    记录编号: `WEAT-${String(id).padStart(4, '0')}`,
    观测站点: form.观测站点.trim(),
    观测时间: form.观测时间.trim(),
    气温: form.气温.trim(),
    相对湿度: form.相对湿度.trim(),
    风速风向: form.风速风向.trim(),
    降水量: form.降水量.trim(),
    记录状态: '已录入',
    观测员: operator,
    班次: shiftLabel,
    复核人: '',
    复核备注: '',
    修正依据: '',
    修正人: '',
    修正时间: '',
    复核时间: '',
    lockVersion: 0,
  }
  persist([...rows, row])
  return { ok: true, message: `已登记 ${row['记录编号']}，缺测项已按口径保留空白` }
}

/** 观测员修正本班次记录：异常值必须写修正依据，采样时间保持原值。 */
export function saveWeatherCorrection(
  id: number,
  form: WeatherForm,
  basis: string,
  operator: string,
  shiftLabel: string,
): ActionResult {
  const rows = listRows(KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的气象观测记录` }
  const current = rows[index]
  if (isLocked(current)) return { ok: false, message: '该记录已复核锁定，重复提交不能覆盖已审核结论' }
  if (!canObserverEdit(current, shiftLabel)) {
    return { ok: false, message: '观测员只能修正本班次记录' }
  }

  const before = weatherDetail(current)
  const trial = {
    气温: form.气温.trim(),
    相对湿度: form.相对湿度.trim(),
    风速风向: form.风速风向.trim(),
    降水量: form.降水量.trim(),
  }
  const stillAbnormal = abnormalItems(trial)
  if (stillAbnormal.length > 0 && isBlank(basis.trim())) {
    return { ok: false, message: '存在异常值，必须填写修正依据后才能保存' }
  }

  const wasAbnormal = before.abnormals.length > 0 || String(current.status) === '异常值'
  const updated: EntryRow = {
    ...current,
    观测站点: form.观测站点.trim(),
    // 观测时间不动：历史记录保持原采样时间。
    ...trial,
    status: stillAbnormal.length > 0 ? '异常值' : wasAbnormal ? '已修正' : '已录入',
    abnormal: stillAbnormal.length > 0,
    pending: true,
    修正依据: basis.trim() ? `${formatNow()} ${operator}：${basis.trim()}` : String(current['修正依据'] ?? ''),
    修正人: operator,
    修正时间: formatNow(),
  }
  updated['记录状态'] = updated.status
  const next = [...rows]
  next[index] = updated
  persist(next)
  return { ok: true, message: stillAbnormal.length ? '已保存，仍有异常值待处理' : '修正已保存，等待复核确认' }
}

/** 复核环节把记录退回为异常，需填写说明；不锁定，留给本班观测员修正后再复核。 */
export function markWeatherAbnormal(id: number, note: string, reviewer: string): ActionResult {
  const rows = listRows(KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的气象观测记录` }
  const current = rows[index]
  if (isLocked(current)) return { ok: false, message: '该记录已复核锁定，重复提交不能覆盖已审核结论' }
  if (isBlank(note.trim())) return { ok: false, message: '标记异常必须说明修正依据或退回理由' }

  const updated: EntryRow = {
    ...current,
    status: '异常值',
    abnormal: true,
    pending: true,
    复核备注: `${formatNow()} ${reviewer} 退回：${note.trim()}`,
  }
  updated['记录状态'] = '异常值'
  const next = [...rows]
  next[index] = updated
  persist(next)
  return { ok: true, message: '已标记异常并退回本班观测员，修正后可重新提交复核' }
}

/**
 * 复核确认：四项缺测不能确认；有未说明的异常不能确认。
 * 通过即写入唯一结论、锁版本 +1，并沿气象→火险调用链同步下游。
 */
export function confirmWeatherReview(id: number, context: ReviewContext): ActionResult {
  const rows = listRows(KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的气象观测记录` }
  const current = rows[index]
  // 并发审核优先判定：别人已先落结论（锁版本变了），本次提交作废，只落第一份结论。
  if (Number(current['lockVersion'] ?? 0) !== context.expectedLockVersion) {
    return { ok: false, message: '该记录刚被他人复核过，结论已更新，请刷新后查看' }
  }
  if (isLocked(current)) {
    return { ok: false, message: '该记录已复核，重复提交不会覆盖已审核结论' }
  }

  const detail = weatherDetail(current)
  if (detail.missing.length > 0) {
    return { ok: false, message: `气温、相对湿度、风速风向、降水量存在缺测（${detail.missing.join('、')}），不能直接确认` }
  }
  if (detail.abnormals.length > 0) {
    return { ok: false, message: `异常值未修正（${detail.abnormals.map((item) => item.field).join('、')}），请退回观测员并说明修正依据` }
  }

  const grade = detail.grade as FireGrade
  const hadCorrection = String(current.status) === '异常值' || !isBlank(current['修正人'])
  const status = hadCorrection ? '已修正' : '已审核'
  const updated: EntryRow = {
    ...current,
    status,
    abnormal: false,
    pending: false,
    复核人: context.operator,
    复核备注: context.remark.trim() || `${formatNow()} 复核通过，要素齐全无异常`,
    复核时间: formatNow(),
    lockVersion: context.expectedLockVersion + 1,
    火险等级: grade,
  }
  updated['记录状态'] = status
  const next = [...rows]
  next[index] = updated
  persist(next)

  // 气象→火险现有调用链：重算监测点等级、巡护风险提示、检查站核查清单。
  syncReviewedWeather(current as unknown as Record<string, unknown>, updated as unknown as Record<string, unknown>)

  return { ok: true, message: `复核完成：结论「${status}」，火险重算为「${grade}」，监测点/巡护/检查站已同步` }
}

/* ------------------------- 气象 → 火险 下游同步 ------------------------- */

/** 取一个站点最新的已复核记录；历史记录用各自原采样时间，不挪动。 */
function latestReviewedAt(station: string): Record<string, unknown> | null {
  const rows = listRows(KEY)
    .filter((row) => isLocked(row) && String(row['观测站点'] ?? '') === station)
    .sort((a, b) => String(b['观测时间']).localeCompare(String(a['观测时间'])))
  return rows.length ? (rows[0] as unknown as Record<string, unknown>) : null
}

function syncFirewatch(record: Record<string, unknown>, grade: FireGrade): void {
  const rows = listRows('firewatch')
  const station = String(record['观测站点'])
  let touched = false
  const next = rows.map((row) => {
    if (String(row['监测区域'] ?? '') !== station) return row
    touched = true
    return {
      ...row,
      // 看板等级跟着重算结果走。
      status: grade,
      火险等级: grade,
      风力等级: String(record['风速风向'] ?? ''),
      相对湿度: String(record['相对湿度'] ?? ''),
      气温读数: String(record['气温'] ?? ''),
      监测时间: String(record['观测时间'] ?? ''),
      等级依据: `依据${String(record['记录编号'])}复核结论重算`,
      重算时间: formatNow(),
    }
  })
  if (touched) saveRows('firewatch', next)
}

function syncPatrol(record: Record<string, unknown>, grade: FireGrade): void {
  const rows = listRows('patrol')
  const station = String(record['观测站点'])
  const source = `${String(record['记录编号'])}（${String(record['观测时间'])}）`
  let touched = false
  const next = rows.map((row) => {
    if (String(row['巡护区域'] ?? '') !== station) return row
    touched = true
    return { ...row, 风险提示: riskHint(grade, source), 风险等级: grade, 风险更新时间: formatNow() }
  })
  if (touched) saveRows('patrol', next)
}

function syncCheckpoint(record: Record<string, unknown>, grade: FireGrade): void {
  const rows = listRows('checkpoint')
  const station = String(record['观测站点'])
  const source = `${String(record['记录编号'])}复核`
  let touched = false
  const next = rows.map((row) => {
    if (String(row['关联区域'] ?? '') !== station && String(row['站点位置'] ?? '') !== station) return row
    touched = true
    const items = checklistItems(grade, record).map((item) => `[${grade}·${source}] ${item}`)
    return {
      ...row,
      检查项目: items.join('；'),
      核查清单: items.join('\n'),
      风险等级: grade,
      清单更新时间: formatNow(),
    }
  })
  if (touched) saveRows('checkpoint', next)
}

export function syncReviewedWeather(_before: Record<string, unknown>, after: Record<string, unknown>): void {
  const grade = gradeOf(after)
  if (grade === null) return
  syncFirewatch(after, grade)
  syncPatrol(after, grade)
  syncCheckpoint(after, grade)
}

/** 看板入口：按全部已复核记录重算一遍，重复调用幂等，只保留一份同步结果。 */
export function recomputeAllFromWeather(): { stations: number; grade: FireGrade } {
  const stations = new Set<string>()
  listRows(KEY)
    .filter((row) => isLocked(row))
    .forEach((row) => stations.add(String(row['观测站点'] ?? '')))
  let highest: FireGrade = '正常'
  stations.forEach((station) => {
    const latest = latestReviewedAt(station)
    if (!latest) return
    const grade = gradeOf(latest)
    if (grade && GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(highest)) highest = grade
    if (grade) {
      syncFirewatch(latest, grade)
      syncPatrol(latest, grade)
      syncCheckpoint(latest, grade)
    }
  })
  return { stations: stations.size, grade: highest }
}
