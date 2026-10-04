<template>
  <section class="page" data-module="weather">
    <header class="page-head">
      <div>
        <h2>气象观测管理</h2>
        <p class="page-desc">
          执行复核口径：气温、相对湿度、风速风向、降水量任一缺测或异常不得直接确认；缺测值保留空白不自动补齐，补录与修正须注明依据；复核后联动重算火险等级。
        </p>
      </div>
      <div class="page-actions">
        <label class="shift-switch">
          当前班次
          <select :value="store.shiftLabel" @change="onShiftChange">
            <option v-for="shift in SHIFTS" :key="shift" :value="shift">{{ shift }}</option>
          </select>
        </label>
        <button class="btn primary" type="button" @click="openCreate">登记气象观测记录</button>
        <button class="btn" type="button" @click="exportRows">导出气象观测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <span v-if="cellState(row, column) === 'missing'" class="cell-missing">缺测（空白）</span>
            <span v-else-if="cellState(row, column) === 'abnormal'" class="cell-abnormal">
              {{ row[column] }}
              <small>（异常）</small>
            </span>
            <span v-else>{{ row[column] === '' ? '' : (row[column] ?? '—') }}</span>
          </td>
          <td>
            {{ row.status }}
            <span v-if="isLocked(row)" class="cell-lock">已锁定 · {{ String(row['复核人']) }}</span>
          </td>
          <td class="row-actions">
            <template v-for="item in rowActions(row)" :key="item.label">
              <button
                class="link"
                type="button"
                :disabled="!!item.disabled || submittingId === Number(row.id)"
                :title="item.disabled ?? ''"
                @click="item.run()"
              >
                {{ item.label }}
              </button>
            </template>
            <span v-if="isLocked(row)" class="cell-lock">已复核，结论不可覆盖</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无气象观测数据，可先登记气象观测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条气象观测记录 · 复核结论落定后自动同步火险监测点、巡护任务与检查站核查项</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 登记 / 编辑弹窗 -->
    <div v-if="formOpen" class="modal-mask" @click.self="closeForm">
      <div class="modal">
        <h3>{{ formMode === 'create' ? '登记气象观测记录' : `编辑 ${formNo}（本班次）` }}</h3>
        <p class="modal-sub">
          缺测要素直接留空即可，不要填占位文字；历史记录的观测时间保持原采样时间，编辑时不可改动。
        </p>
        <div class="form-grid">
          <label>
            <span>观测站点 *</span>
            <input v-model="form.station" placeholder="如：青松岭气象站" />
          </label>
          <label>
            <span>关联监测点编号</span>
            <input v-model="form.monitorPoint" placeholder="如：FIRE-0001（用于复核后联动重算）" />
          </label>
          <label>
            <span>观测时间 *</span>
            <input v-model="form.observedAt" placeholder="YYYY-MM-DD HH:mm" :disabled="formMode === 'edit'" />
          </label>
          <label>
            <span>观测员</span>
            <input :value="store.operator" disabled />
          </label>
          <label>
            <span>气温（℃，缺测留空）</span>
            <input v-model="form.temperature" placeholder="如：24.6℃" />
          </label>
          <label>
            <span>相对湿度（%，缺测留空）</span>
            <input v-model="form.humidity" placeholder="如：52%" />
          </label>
          <label>
            <span>风速风向（缺测留空）</span>
            <input v-model="form.wind" placeholder="如：西北风3级 或 4.2m/s" />
          </label>
          <label>
            <span>降水量（mm，缺测留空）</span>
            <input v-model="form.rainfall" placeholder="无降水填 0mm" />
          </label>
        </div>
        <p v-if="formError" class="error-text" style="margin-top:10px">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
          <button class="btn primary" type="button" :disabled="submittingId !== null" @click="submitForm">
            {{ formMode === 'create' ? '登记' : '保存修改' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 复核面板 -->
    <div v-if="reviewOpen && reviewRow" class="modal-mask" @click.self="closeReview">
      <div class="modal">
        <h3>气象数据复核 · {{ String(reviewRow['记录编号']) }}</h3>
        <p class="modal-sub">
          {{ String(reviewRow['观测站点']) }} · {{ String(reviewRow['观测时间']) }} ·
          观测员 {{ String(reviewRow['观测员']) }}（{{ String(reviewRow['班次']) }}）。
          缺测保留空白，可引用前一有效时次手工补录；任何补录/修正都必须写明依据。
        </p>

        <div class="review-factors">
          <div v-for="factor in reviewCheck?.factors ?? []" :key="factor.field" class="factor-line">
            <span>
              {{ factor.field }}
              <span class="tag" :class="factor.state">{{ stateLabel(factor.state) }}</span>
            </span>
            <div>
              <input
                v-model="reviewFactors[factor.field]"
                :placeholder="factor.state === 'missing' ? '缺测（留空保留）或补录值' : '原值，可在此修正'"
              />
              <p v-if="factor.reason" class="previous-hint" style="margin-left:0;color:#b42318">{{ factor.reason }}</p>
              <p v-else-if="reviewCheck?.previousValid[factor.field]" class="previous-hint">
                前一有效时次：{{ reviewCheck?.previousValid[factor.field] }}（引用需自行粘贴并注明依据）
              </p>
            </div>
          </div>
        </div>

        <label class="wide" style="display:block">
          <span style="display:block;font-size:12px;color:var(--muted);margin-bottom:3px">
            复核依据 / 修正说明 *
          </span>
          <textarea
            v-model="reviewBasis"
            placeholder="如：经与自动站核对，气温由 85℃ 更正为 28.5℃；或：气温缺测，本时次保留空白，火险按保守口径重算"
          ></textarea>
        </label>
        <p v-if="reviewError" class="error-text" style="margin-top:10px">{{ reviewError }}</p>

        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeReview">取消</button>
          <button class="btn" type="button" :disabled="submittingId === Number(reviewRow.id)" @click="submitReview('abnormal')">
            维持异常值结论
          </button>
          <button class="btn primary" type="button" :disabled="submittingId === Number(reviewRow.id)" @click="submitReview('confirm')">
            确认复核结论
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  applyReview,
  canEditShift,
  editWeather,
  markWeatherAbnormal,
  registerWeather,
  submitWeather,
  type OperatorContext,
  type WeatherForm,
} from '@/api/weather-service'
import { STORE_CHANGE_EVENT } from '@/data/local-store'
import {
  WEATHER_REQUIRED_FACTORS,
  inspectWeather,
  type WeatherCheck,
  type WeatherFactor,
} from '@/domain/weather'
import type { EntryRow } from '@/data/types'
import { SHIFTS, useSessionStore } from '@/stores/session'

const meta = moduleMeta('weather')
const store = useSessionStore()
const columns = ["记录编号", "观测站点", "关联监测点", "观测时间", "气温", "相对湿度", "风速风向", "降水量", "观测员", "班次", "记录状态", "复核依据"]
const statuses = ["已录入", "已审核", "已修正", "异常值"]
const LOCKED_STATUSES = ['已审核', '已修正']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["记录编号", "观测站点", "关联监测点"]
const submittingId = ref<number | null>(null)

const stats = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return [
    { label: '今日观测数', value: rows.value.filter((row) => String(row['观测时间']).startsWith(today)).length },
    { label: '待复核记录', value: rows.value.filter((row) => !LOCKED_STATUSES.includes(String(row.status))).length },
    { label: '异常记录数', value: rows.value.filter((row) => row.abnormal).length },
  ]
})

function isLocked(row: EntryRow): boolean {
  return LOCKED_STATUSES.includes(String(row.status))
}

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const checkCache = new Map<number, WeatherCheck>()
function checkOf(row: EntryRow): WeatherCheck {
  const cached = checkCache.get(Number(row.id))
  if (cached) {
    return cached
  }
  const check = inspectWeather(row, rows.value)
  checkCache.set(Number(row.id), check)
  return check
}

function cellState(row: EntryRow, column: string): 'ok' | 'missing' | 'abnormal' | '' {
  if (!(WEATHER_REQUIRED_FACTORS as readonly string[]).includes(column)) {
    return ''
  }
  return checkOf(row).factors.find((item) => item.field === column)?.state ?? ''
}

function stateLabel(state: 'ok' | 'missing' | 'abnormal'): string {
  return { ok: '正常', missing: '缺测', abnormal: '异常' }[state]
}

type RowAction = { label: string; disabled?: string; run: () => void }

function rowActions(row: EntryRow): RowAction[] {
  if (isLocked(row)) {
    return []
  }
  const ctx: OperatorContext = { operator: store.operator, shiftLabel: store.shiftLabel }
  const mine = canEditShift(row, ctx)
  const actions: RowAction[] = []
  if (mine) {
    actions.push({
      label: '修改本班记录',
      run: () => openEdit(row),
    })
    actions.push({
      label: '标记异常',
      run: () => markAbnormal(row),
    })
    actions.push({
      label: '提交审核',
      run: () => submitDirect(row),
    })
  } else {
    actions.push({ label: '修改本班记录', disabled: '非本班次记录，观测员只能修改本班次记录', run: () => {} })
  }
  // 复核是独立审核动作，值班管理员可对任何未锁定记录复核（跨班次也可，因为属于审核环节）。
  actions.push({ label: '数据复核', run: () => openReview(row) })
  return actions
}

// 登记 / 编辑
const formOpen = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const formNo = ref('')
const formEditId = ref<number | null>(null)
const formError = ref('')
const form = reactive<WeatherForm>({
  station: '', monitorPoint: '', observedAt: '',
  temperature: '', humidity: '', wind: '', rainfall: '',
})

function resetForm() {
  form.station = ''
  form.monitorPoint = ''
  form.observedAt = ''
  form.temperature = ''
  form.humidity = ''
  form.wind = ''
  form.rainfall = ''
  formError.value = ''
}

function openCreate() {
  formMode.value = 'create'
  formNo.value = ''
  formEditId.value = null
  resetForm()
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  form.observedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:00`
  formOpen.value = true
}

function openEdit(row: EntryRow) {
  const ctx: OperatorContext = { operator: store.operator, shiftLabel: store.shiftLabel }
  if (!canEditShift(row, ctx)) {
    errorMessage.value = '观测员只能修改本班次记录'
    return
  }
  formMode.value = 'edit'
  formNo.value = String(row['记录编号'])
  formEditId.value = Number(row.id)
  form.station = String(row['观测站点'] ?? '')
  form.monitorPoint = String(row['关联监测点'] ?? '')
  form.observedAt = String(row['观测时间'] ?? '')
  form.temperature = String(row['气温'] ?? '')
  form.humidity = String(row['相对湿度'] ?? '')
  form.wind = String(row['风速风向'] ?? '')
  form.rainfall = String(row['降水量'] ?? '')
  formError.value = ''
  formOpen.value = true
}

function closeForm() {
  if (submittingId.value !== null) {
    return
  }
  formOpen.value = false
}

function submitForm() {
  const ctx: OperatorContext = { operator: store.operator, shiftLabel: store.shiftLabel }
  const result = formMode.value === 'create'
    ? registerWeather(form, ctx)
    : editWeather(formEditId.value ?? -1, form, ctx)
  formError.value = result.ok ? '' : result.message
  if (result.ok) {
    formOpen.value = false
    errorMessage.value = ''
    reload()
  }
}

// 标记异常：用快捷 prompt 收集说明，沿用现有流程，不另开面板。
function markAbnormal(row: EntryRow) {
  const basis = window.prompt(`标记异常需说明情况（记录 ${String(row['记录编号'])}）：`)
  if (basis === null) {
    return
  }
  const ctx: OperatorContext = { operator: store.operator, shiftLabel: store.shiftLabel }
  const result = markWeatherAbnormal(Number(row.id), basis, ctx)
  errorMessage.value = result.ok ? '' : result.message
  if (result.ok) {
    reload()
  }
}

function submitDirect(row: EntryRow) {
  submittingId.value = Number(row.id)
  const result = submitWeather(Number(row.id))
  submittingId.value = null
  errorMessage.value = result.ok ? '' : result.message
  if (result.ok) {
    reload()
  }
}

// 复核面板
const reviewOpen = ref(false)
const reviewRow = ref<EntryRow | null>(null)
const reviewCheck = ref<WeatherCheck | null>(null)
const reviewFactors = reactive<Partial<Record<WeatherFactor, string>>>({})
const reviewBasis = ref('')
const reviewError = ref('')

function openReview(row: EntryRow) {
  reviewRow.value = row
  reviewCheck.value = inspectWeather(row, rows.value)
  for (const factor of reviewCheck.value.factors) {
    reviewFactors[factor.field] = String(row[factor.field] ?? '')
  }
  reviewBasis.value = ''
  reviewError.value = ''
  reviewOpen.value = true
}

function closeReview() {
  if (submittingId.value !== null) {
    return
  }
  reviewOpen.value = false
  reviewRow.value = null
}

function submitReview(decision: 'confirm' | 'abnormal') {
  if (!reviewRow.value) {
    return
  }
  const id = Number(reviewRow.value.id)
  submittingId.value = id
  const result = applyReview(
    id,
    { factors: { ...reviewFactors }, decision, basis: reviewBasis.value },
    { operator: store.operator, shiftLabel: store.shiftLabel },
  )
  submittingId.value = null
  reviewError.value = result.ok ? '' : result.message
  if (result.ok) {
    reviewOpen.value = false
    reviewRow.value = null
    errorMessage.value = ''
    reload()
  }
}

function onShiftChange(event: Event) {
  store.setShift((event.target as HTMLSelectElement).value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  checkCache.clear()
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '气象观测列表读取失败'
  }
}

// 其它标签页/本页复核落盘后，气象列表跟随刷新。
function onStoreChange() {
  reload()
}

onMounted(() => {
  reload()
  window.addEventListener(STORE_CHANGE_EVENT, onStoreChange)
})
onBeforeUnmount(() => {
  window.removeEventListener(STORE_CHANGE_EVENT, onStoreChange)
})
</script>
