import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
const SCHEMA_KEY = 'forest-fire-patrol:schemaVersion'
// 气象复核口径改造涉及的模块：旧版缓存里这几块是占位样例，需要一次性换成新结构。
const MIGRATED_MODULES = ['weather', 'firewatch', 'patrol', 'checkpoint']
const SCHEMA_VERSION = 'weather-review-v2'

// 数据落盘后广播一次，火险看板、巡护页可以即时跟随重算后的等级刷新。
export type StoreChangeDetail = { module: string }
export const STORE_CHANGE_EVENT = 'forest-store-change'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emitChange(module: string): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<StoreChangeDetail>(STORE_CHANGE_EVENT, { detail: { module } }))
  }
}

function legacyWeatherDetected(parsed: Record<string, EntryRow[]>): boolean {
  // 旧版气象行没有「观测员」字段，且读数是占位文本；命中其一即认定是改造前缓存。
  const weather = parsed.weather ?? []
  return weather.some((row) => row['观测员'] === undefined)
}

function seedFor(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

function readStorage(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedFor()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fallback = seedFor()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(SCHEMA_KEY, SCHEMA_VERSION)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const version = window.localStorage.getItem(SCHEMA_KEY)
    if (version !== SCHEMA_VERSION && legacyWeatherDetected(parsed)) {
      // 只重置本次改造涉及的模块，其它模块保留用户已登记的数据。
      const migrated = { ...parsed }
      for (const key of MIGRATED_MODULES) {
        migrated[key] = clone(SEED_ROWS[key] ?? [])
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
      window.localStorage.setItem(SCHEMA_KEY, SCHEMA_VERSION)
      cache = migrated
      return migrated
    }
    // 结构已是新版但缺版本标记时补齐，避免重复迁移。
    if (version !== SCHEMA_VERSION) {
      window.localStorage.setItem(SCHEMA_KEY, SCHEMA_VERSION)
    }
    return { ...seedFor(), ...parsed }
  } catch {
    const fallback = seedFor()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(SCHEMA_KEY, SCHEMA_VERSION)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

// 跨标签页：别处落盘后把本页缓存换成最新值，并广播给页面刷新，避免并发审核时看到陈旧结论。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) {
      return
    }
    try {
      cache = { ...seedFor(), ...(JSON.parse(event.newValue) as Record<string, EntryRow[]>) }
      emitChange('*')
    } catch {
      // 解析失败时保留现有缓存，下一次写入会自愈。
    }
  })
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 直接读 localStorage 最新值：多标签页或并发落盘时避免用陈旧缓存互相覆盖。 */
function freshRows(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return allRows()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return allRows()
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...seedFor(), ...parsed }
  } catch {
    return allRows()
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  // 写前重读：以磁盘上的全量数据为底，只换本模块，避免覆盖别的模块/标签页的并发改动。
  const base = freshRows()
  const next = { ...base, [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  emitChange(key)
}

/**
 * 比较并交换：expected 是调用方动手前那一行（含版本号），
 * 期间被别人改过（复核人已落结论或版本号变动）则本次写入失败，保证并发只落一份结论。
 */
export function compareAndSwapRow(
  key: string,
  id: number,
  expected: EntryRow,
  patch: Partial<EntryRow>,
): EntryRow | null {
  const base = freshRows()
  const rows = base[key] ?? []
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return null
  }
  const current = rows[index]
  if (Number(current.reviewVersion ?? 0) !== Number(expected.reviewVersion ?? 0)) {
    return null
  }
  const nextVersion = Number(current.reviewVersion ?? 0) + 1
  const updated: EntryRow = { ...current, ...patch, reviewVersion: nextVersion }
  const nextRows = [...rows]
  nextRows[index] = updated
  const nextAll = { ...base, [key]: nextRows }
  cache = nextAll
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextAll))
  }
  emitChange(key)
  return updated
}

export function appendRow(key: string, row: EntryRow): void {
  const base = freshRows()
  const next = { ...base, [key]: [...(base[key] ?? []), row] }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  emitChange(key)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
