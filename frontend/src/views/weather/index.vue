<template>
  <section class="page" data-module="weather">
    <header class="page-head">
      <div>
        <h2>气象观测管理</h2>
        <p class="page-desc">
          复核口径：气温、相对湿度、风速风向、降水量任一缺测不能直接确认；异常值需写明修正依据。缺测项保留空白、不按前值补齐，历史记录保持原采样时间。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记气象观测记录</button>
        <button class="btn" type="button" @click="exportRows">导出气象观测清单</button>
      </div>
    </header>

    <div class="identity-bar">
      <span>当前身份</span>
      <input v-model="store.operator" class="identity-input" aria-label="观测员" />
      <select v-model="store.shiftLabel" class="identity-input" aria-label="班次">
        <option>白班 08:00-20:00</option>
        <option>夜班 20:00-08:00</option>
      </select>
      <em class="identity-hint">观测员只能修正本班次记录；复核通过即锁定，重复提交不覆盖结论</em>
    </div>

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
          <th>复核口径</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-locked': detailOf(row).locked }">
          <td v-for="column in columns" :key="column" class="cell-mono">
            <template v-if="column === '气温' || column === '相对湿度' || column === '风速风向' || column === '降水量'">
              <span v-if="row[column] === '' || row[column] === undefined" class="missing-tag">缺测</span>
              <span v-else :class="{ 'abnormal-cell': isAbnormalField(row, column) }">{{ row[column] }}</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td class="cell-criteria">
            <span v-if="detailOf(row).locked" class="lock-tag">已锁定 · {{ row['复核人'] }}</span>
            <template v-else>
              <span v-for="item in detailOf(row).missing" :key="item" class="missing-tag">{{ item }}缺测</span>
              <span v-for="item in detailOf(row).abnormals" :key="item.field" class="abnormal-tag">
                {{ item.field }}异常
              </span>
              <span v-if="!detailOf(row).missing.length && !detailOf(row).abnormals.length" class="ok-tag">
                要素齐全 · 预估{{ detailOf(row).grade }}
              </span>
            </template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="canCorrect(row)"
              class="link"
              type="button"
              @click="openCorrect(row)"
            >录入修正</button>
            <button
              v-if="!detailOf(row).locked"
              class="link"
              type="button"
              @click="openMark(row)"
            >标记异常</button>
            <button
              v-if="!detailOf(row).locked"
              class="link"
              type="button"
              @click="openReview(row)"
            >复核</button>
            <span v-if="detailOf(row).locked" class="muted-text">结论已锁定</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无气象观测数据，可先登记气象观测记录</td>
        </tr>
      </tbody>
    </table>

    <!-- 登记 / 修正共用表单 -->
    <div v-if="formMode" class="modal-mask" @click.self="closeForm">
      <div class="modal">
        <h3 class="modal-title">{{ formMode === 'create' ? '登记气象观测记录' : '修正本班次记录' }}</h3>
        <p class="modal-sub">
          {{ formMode === 'create'
            ? `观测员：${store.operator} · ${store.shiftLabel}；缺测项留空即可，不会按前一有效值补齐。`
            : `仅可修正 ${store.shiftLabel} 本班次记录；观测时间（采样时间）保持不变。` }}
        </p>
        <div class="form-grid">
          <label class="form-item">
            <span>观测站点</span>
            <input v-model="form.观测站点" :disabled="formMode === 'correct'" placeholder="如：青云岭" />
          </label>
          <label class="form-item">
            <span>观测时间</span>
            <input :value="form.观测时间" disabled />
          </label>
          <label class="form-item">
            <span>气温（℃）</span>
            <input v-model="form.气温" placeholder="如 26.4℃，缺测留空" />
          </label>
          <label class="form-item">
            <span>相对湿度（%）</span>
            <input v-model="form.相对湿度" placeholder="如 41%，缺测留空" />
          </label>
          <label class="form-item">
            <span>风速风向</span>
            <input v-model="form.风速风向" placeholder="如 东南风3级，缺测留空" />
          </label>
          <label class="form-item">
            <span>降水量（mm）</span>
            <input v-model="form.降水量" placeholder="如 0mm / 无，缺测留空" />
          </label>
        </div>
        <label v-if="formMode === 'correct'" class="form-item basis-item">
          <span>修正依据 <em>（异常值必填）</em></span>
          <textarea v-model="basis" rows="2" placeholder="说明对照自记纸/仪器校检记录等修正依据"></textarea>
        </label>
        <p v-if="formHint" class="error-text">{{ formHint }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
          <button class="btn primary" type="button" @click="submitForm">
            {{ formMode === 'create' ? '登记' : '保存修正' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 标记异常 -->
    <div v-if="markTarget" class="modal-mask" @click.self="closeMark">
      <div class="modal">
        <h3 class="modal-title">标记异常 · {{ markTarget['记录编号'] }}</h3>
        <p class="modal-sub">退回本班观测员修正，记录不锁定；必须说明异常情况与修正依据要求。</p>
        <label class="form-item">
          <span>异常说明 / 修正依据要求</span>
          <textarea v-model="markNote" rows="3" placeholder="如：气温 99.9℃ 超出量程，请对照自记纸核实订正"></textarea>
        </label>
        <p v-if="markHint" class="error-text">{{ markHint }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeMark">取消</button>
          <button class="btn primary" type="button" @click="submitMark">标记异常并退回</button>
        </div>
      </div>
    </div>

    <!-- 复核确认 -->
    <div v-if="reviewTarget" class="modal-mask" @click.self="closeReview">
      <div class="modal">
        <h3 class="modal-title">复核 · {{ reviewTarget['记录编号'] }}</h3>
        <p class="modal-sub">复核人：{{ store.operator }}。复核通过后火险监测点等级、巡护风险提示、检查站核查清单将同步重算。</p>
        <dl class="review-grid">
          <div v-for="field in reviewFields" :key="field">
            <dt>{{ field }}</dt>
            <dd :class="{ 'abnormal-cell': isAbnormalField(reviewTarget, field) }">
              <span v-if="reviewTarget[field] === ''" class="missing-tag">缺测</span>
              <template v-else>{{ reviewTarget[field] }}</template>
            </dd>
          </div>
        </dl>
        <ul class="review-criteria">
          <li v-for="item in reviewDetail?.missing" :key="'m' + item" class="criteria-bad">✕ {{ item }}缺测，不能确认</li>
          <li v-for="item in reviewDetail?.abnormals" :key="'a' + item.field" class="criteria-bad">
            ✕ {{ item.field }}异常：{{ item.reason }}
          </li>
          <li v-if="!reviewDetail?.missing.length && !reviewDetail?.abnormals.length" class="criteria-ok">
            ✓ 四项要素齐全且无异常，可确认；预估火险等级「{{ reviewDetail?.grade }}」
          </li>
          <li v-if="reviewTarget['修正依据']" class="criteria-info">修正依据：{{ reviewTarget['修正依据'] }}</li>
        </ul>
        <label class="form-item">
          <span>复核备注</span>
          <textarea v-model="reviewRemark" rows="2" placeholder="可选，留空默认记录复核通过"></textarea>
        </label>
        <p v-if="reviewHint" class="error-text">{{ reviewHint }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeReview">取消</button>
          <button class="btn" type="button" @click="submitReview(false)">退回标记异常</button>
          <button class="btn primary" type="button" @click="submitReview(true)">确认通过</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条气象观测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  canObserverEdit,
  confirmWeatherReview,
  createWeatherRecord,
  markWeatherAbnormal,
  saveWeatherCorrection,
  weatherDetail,
  type WeatherForm,
} from '@/api/weather-service'
import { abnormalItems, isBlank } from '@/data/weather-domain'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('weather')
const columns = [
  '记录编号', '观测站点', '观测时间', '气温', '相对湿度', '风速风向', '降水量',
  '观测员', '班次', '复核人', '复核时间', '修正依据', '火险等级',
]
const statuses = ['已录入', '异常值', '已审核', '已修正']
const reviewFields = ['气温', '相对湿度', '风速风向', '降水量'] as const

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['记录编号', '观测站点', '观测时间']

const detailCache = computed(() => {
  const map = new Map<number, ReturnType<typeof weatherDetail>>()
  rows.value.forEach((row) => map.set(Number(row.id), weatherDetail(row)))
  return map
})
function detailOf(row: EntryRow) {
  return detailCache.value.get(Number(row.id)) ?? weatherDetail(row)
}
function isAbnormalField(row: EntryRow, field: string): boolean {
  return abnormalItems(row as unknown as Record<string, unknown>).some((item) => item.field === field)
}
function canCorrect(row: EntryRow): boolean {
  return canObserverEdit(row, store.shiftLabel) && String(row['观测员']) === store.operator
}

const stats = computed(() => {
  const locked = rows.value.filter((row) => detailOf(row).locked).length
  return [
    { label: '全部观测数', value: rows.value.length },
    { label: '待复核记录', value: rows.value.length - locked },
    { label: '异常记录数', value: rows.value.filter((row) => row.abnormal).length },
  ]
})
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

/* 登记 / 修正弹窗 */
type FormMode = 'create' | 'correct' | null
const formMode = ref<FormMode>(null)
const formTargetId = ref<number | null>(null)
const emptyForm = (): WeatherForm => ({ 观测站点: '', 观测时间: '', 气温: '', 相对湿度: '', 风速风向: '', 降水量: '' })
const form = ref<WeatherForm>(emptyForm())
const basis = ref('')
const formHint = ref('')

function todayStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function openCreate() {
  formMode.value = 'create'
  formTargetId.value = null
  form.value = { ...emptyForm(), 观测时间: todayStamp() }
  basis.value = ''
  formHint.value = ''
}

function openCorrect(row: EntryRow) {
  formMode.value = 'correct'
  formTargetId.value = Number(row.id)
  form.value = {
    观测站点: String(row['观测站点'] ?? ''),
    观测时间: String(row['观测时间'] ?? ''),
    气温: String(row['气温'] ?? ''),
    相对湿度: String(row['相对湿度'] ?? ''),
    风速风向: String(row['风速风向'] ?? ''),
    降水量: String(row['降水量'] ?? ''),
  }
  basis.value = ''
  formHint.value = ''
}

function closeForm() {
  formMode.value = null
  formTargetId.value = null
}

function submitForm() {
  formHint.value = ''
  if (isBlank(form.value.观测站点)) {
    formHint.value = '观测站点不能为空'
    return
  }
  const result = formMode.value === 'create'
    ? createWeatherRecord(form.value, store.operator, store.shiftLabel)
    : saveWeatherCorrection(formTargetId.value as number, form.value, basis.value, store.operator, store.shiftLabel)
  if (!result.ok) {
    formHint.value = result.message
    return
  }
  errorMessage.value = result.message
  closeForm()
  reload()
}

/* 标记异常弹窗 */
const markTarget = ref<EntryRow | null>(null)
const markNote = ref('')
const markHint = ref('')

function openMark(row: EntryRow) {
  markTarget.value = row
  markNote.value = ''
  markHint.value = ''
}
function closeMark() {
  markTarget.value = null
}
function submitMark() {
  if (!markTarget.value) return
  const result = markWeatherAbnormal(Number(markTarget.value.id), markNote.value, store.operator)
  if (!result.ok) {
    markHint.value = result.message
    return
  }
  errorMessage.value = result.message
  closeMark()
  reload()
}

/* 复核弹窗：打开时锁版本，提交时比对，防止并发审核落两份结论 */
const reviewTarget = ref<EntryRow | null>(null)
const reviewRemark = ref('')
const reviewHint = ref('')
const reviewLockVersion = ref(0)

const reviewDetail = computed(() => (reviewTarget.value ? weatherDetail(reviewTarget.value) : null))

function openReview(row: EntryRow) {
  reviewTarget.value = row
  reviewRemark.value = ''
  reviewHint.value = ''
  reviewLockVersion.value = weatherDetail(row).lockVersion
}
function closeReview() {
  reviewTarget.value = null
}

function submitReview(pass: boolean) {
  if (!reviewTarget.value) return
  reviewHint.value = ''
  const id = Number(reviewTarget.value.id)
  const result = pass
    ? confirmWeatherReview(id, {
        operator: store.operator,
        shiftLabel: store.shiftLabel,
        expectedLockVersion: reviewLockVersion.value,
        remark: reviewRemark.value,
      })
    : markWeatherAbnormal(id, reviewRemark.value || '复核退回：请按异常提示修正', store.operator)
  if (!result.ok) {
    reviewHint.value = result.message
    return
  }
  errorMessage.value = result.message
  closeReview()
  reload()
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
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '气象观测列表读取失败'
  }
}

onMounted(reload)
</script>
