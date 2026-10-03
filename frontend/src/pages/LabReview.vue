<script setup lang="ts">
/**
 * 实验室镜检复核台：/lab/reviews
 * 镜检复核单独立分账保存（labReviews 表），标本号、复核体长段与复核结论只认本页这份，
 * 观察员补记不会顶回实验室改判。
 * - 送达一批：按「样带编号 + 科名」与观察员台账对账，对不上先挂起等人定；
 * - 挂起单只重试自己这份，不改动观察员任何记录；
 * - 同一批次重送按自然键幂等落账，不多出结论；
 * - 待复检结论落账后，观察员再动数量 / 体长段会自动退回待复核。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Aim, Connection, Delete, DocumentCopy, RefreshRight } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import type { FishCount } from '@/types/fishCount'
import {
  LAB_REVIEW_STATUSES,
  REVIEW_VERDICTS,
  parseLabReviewPaste,
  type LabReviewSheet,
  type LabReviewStatus
} from '@/types/labReview'
import { initDatabase } from '@/utils/db'
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()

const statusFilter = ref<LabReviewStatus | '全部'>('全部')
const pasteVisible = ref(false)
const pasteText = ref('')
const pasteErrors = ref<string[]>([])
const submitting = ref(false)
/** 最近一次送达批次号（同批复核单重送时复用） */
const lastBatchId = ref<string>('')

/** 人工指认挂起单的对话框 */
const resolveVisible = ref(false)
const resolvingSheet = ref<LabReviewSheet | null>(null)
const resolveBeltId = ref<string>('')
const resolveFishId = ref<string>('')

const sheets = computed(() => surveyStore.reviewsByStatus(statusFilter.value))

const stats = computed(() => {
  const all = surveyStore.labReviews
  return {
    total: all.length,
    reviewed: all.filter((sheet) => sheet.status === '已复核').length,
    recount: all.filter((sheet) => sheet.status === '待复检').length,
    suspended: all.filter((sheet) => sheet.status === '挂起').length
  }
})

const SHEET_TAG_TYPE: Record<LabReviewStatus, 'success' | 'danger' | 'warning'> = {
  已复核: 'success',
  待复检: 'danger',
  挂起: 'warning'
}

/** 挂起单可选样带：优先按单上样带编号，匹配不到则列出全部样带供人定 */
const candidateBelts = computed(() => {
  const sheet = resolvingSheet.value
  if (!sheet) return []
  const exact = beltStore.belts.filter((belt) => belt.no === sheet.beltNo)
  const pool = exact.length > 0 ? exact : beltStore.belts
  return pool.map((belt) => {
    const site = reefStore.siteById(belt.siteId)
    const reef = site ? reefStore.reefById(site.reefId) : null
    return {
      id: belt.id,
      label: `${reef?.name ?? '未知礁区'} / 站位 ${site?.no ?? '—'} / 样带 ${belt.no}（${belt.orientation}向）`
    }
  })
})

/** 选定样带后可选的观察员计数行：同科优先，其次全部 */
const candidateFishes = computed<FishCount[]>(() => {
  if (!resolveBeltId.value) return []
  const list = surveyStore.fishesOfBelt(resolveBeltId.value)
  const sameFamily = resolvingSheet.value
    ? list.filter((fish) => fish.family === resolvingSheet.value?.family)
    : []
  return sameFamily.length > 0 ? sameFamily : list
})

function fishOptionLabel(fish: FishCount): string {
  return `${fish.family}（${fish.sizeClass}）× ${fish.count} · ${fish.category} · ${fish.reviewStatus}`
}

function beltLabelOf(sheet: LabReviewSheet): string {
  if (!sheet.beltId) return sheet.beltNo
  const belt = beltStore.beltById(sheet.beltId)
  if (!belt) return sheet.beltNo
  const site = reefStore.siteById(belt.siteId)
  const reef = site ? reefStore.reefById(site.reefId) : null
  return `${reef?.name ?? '未知礁区'} / ${site?.no ?? '—'} / 样带 ${belt.no}`
}

/* ------------------------------ 批量送达 ------------------------------ */

function openPaste(): void {
  pasteText.value = ''
  pasteErrors.value = []
  pasteVisible.value = true
}

function previewPaste(): void {
  const parsed = parseLabReviewPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0 && parsed.errors.length === 0) {
    ElMessage.warning('每行格式「样带编号,科名,观察体长段,复核体长段,标本号,结论[,类别]」')
  }
}

async function submitPaste(resend: boolean): Promise<void> {
  const parsed = parseLabReviewPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0) {
    ElMessage.warning('没有可送达的有效行')
    return
  }
  submitting.value = true
  try {
    // 重送沿用上次批次号：自然键一致 → 只更新原单、重试挂起，不多出结论
    const batchId = resend && lastBatchId.value ? lastBatchId.value : undefined
    const result = await surveyStore.ingestReviewBatch(parsed.rows, batchId)
    lastBatchId.value = result.batchId
    pasteVisible.value = false
    ElMessage.success(
      resend
        ? `批次 ${result.batchId} 重送完成：更新 ${result.updated} 张，仍挂起 ${result.suspended} 张（观察员台账未改动）`
        : `批次 ${result.batchId} 送达：新单 ${result.created} 张，挂起 ${result.suspended} 张等人定`
    )
  } finally {
    submitting.value = false
  }
}

/* ------------------------------ 挂起处理 ------------------------------ */

function openResolve(sheet: LabReviewSheet): void {
  resolvingSheet.value = sheet
  resolveBeltId.value = sheet.beltId ?? candidateBelts.value[0]?.id ?? ''
  resolveFishId.value = sheet.fishId ?? ''
  resolveVisible.value = true
}

async function confirmResolve(): Promise<void> {
  if (!resolvingSheet.value) return
  if (!resolveBeltId.value || !resolveFishId.value) {
    ElMessage.warning('请选定一条观察员计数记录完成对账')
    return
  }
  await surveyStore.resolveReview(resolvingSheet.value.id, resolveFishId.value)
  resolveVisible.value = false
  ElMessage.success('已人工对账，复核结论落账（标本号与结论以实验室这份为准）')
}

async function retrySheet(sheet: LabReviewSheet): Promise<void> {
  const ok = await surveyStore.retryReview(sheet.id)
  if (ok) ElMessage.success('对账成功，结论已落账')
  else ElMessage.warning('按样带编号 + 科名仍对不上，请人工指认；观察员那份未改动')
}

async function removeSheet(sheet: LabReviewSheet): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除复核单「样带 ${sheet.beltNo} · ${sheet.family} · 标本号 ${sheet.specimenNo || '未编号'}」？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await surveyStore.removeReview(sheet.id)
  ElMessage.success('复核单已删除')
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <el-breadcrumb separator="/">
          <el-breadcrumb-item :to="{ path: '/reefs' }">礁区台账</el-breadcrumb-item>
          <el-breadcrumb-item>实验室镜检复核台</el-breadcrumb-item>
        </el-breadcrumb>
        <h2 class="page__title">镜检复核单（实验室台账）</h2>
        <p class="gb-hint">
          按样带编号 + 科名与观察员计数对账：对得上则落「已复核 / 待复检」结论；对不上先挂起等人定。
          标本号、复核体长段与结论只认本页这份，观察员补记不顶回；折算密度仅采纳已复核记录。
        </p>
      </div>
      <div class="page__actions">
        <el-button type="primary" :icon="DocumentCopy" @click="openPaste">送达一批复核单</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="复核单" :value="stats.total" suffix="张" icon="Files" />
      <StatBadge label="已复核" :value="stats.reviewed" suffix="张" tone="success" icon="CircleCheckFilled" />
      <StatBadge label="待复检" :value="stats.recount" suffix="张" tone="danger" icon="WarningFilled" />
      <StatBadge label="挂起等人定" :value="stats.suspended" suffix="张" tone="warning" icon="Connection" />
    </div>

    <div class="page__filter">
      <span class="gb-hint">状态筛选：</span>
      <el-radio-group v-model="statusFilter" size="small">
        <el-radio-button value="全部">全部</el-radio-button>
        <el-radio-button v-for="status in LAB_REVIEW_STATUSES" :key="status" :value="status">{{ status }}</el-radio-button>
      </el-radio-group>
    </div>

    <EmptyPanel
      v-if="sheets.length === 0"
      title="当前筛选下没有复核单"
      description="实验室把镜检结果按「样带编号,科名,观察体长段,复核体长段,标本号,结论」批量送达；对不上观察员台账的会先挂起。"
      action-text="送达一批复核单"
      @action="openPaste"
    />

    <el-table v-else :data="sheets" border stripe class="gb-table-compact">
      <el-table-column label="状态" width="90" align="center">
        <template #default="{ row }: { row: LabReviewSheet }">
          <el-tag size="small" :type="SHEET_TAG_TYPE[row.status]" effect="plain">
            {{ row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="样带 / 礁区站位" min-width="230">
        <template #default="{ row }">{{ beltLabelOf(row) }}</template>
      </el-table-column>
      <el-table-column prop="family" label="科名" min-width="110" />
      <el-table-column label="类别" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="row.category === '鱼类' ? 'primary' : 'warning'" effect="plain">
            {{ row.category }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="观察体长段" width="110">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.observerSizeClass }}</span>
        </template>
      </el-table-column>
      <el-table-column label="复核体长段" width="110">
        <template #default="{ row }">
          <span class="gb-mono">
            <el-tag v-if="row.reviewedSizeClass !== row.observerSizeClass" size="small" type="danger" effect="plain">
              {{ row.reviewedSizeClass }}
            </el-tag>
            <template v-else>{{ row.reviewedSizeClass }}</template>
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="specimenNo" label="标本号" min-width="130">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.specimenNo || '未编号' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="verdict" label="复核结论" width="110" />
      <el-table-column label="批次 / 重试" width="150">
        <template #default="{ row }">
          <div class="gb-hint gb-mono">{{ row.batchId }}</div>
          <div class="gb-hint">自动对账重试 {{ row.attempts }} 次</div>
        </template>
      </el-table-column>
      <el-table-column label="处理" width="210" fixed="right">
        <template #default="{ row }">
          <template v-if="row.status === '挂起'">
            <el-button size="small" type="primary" plain :icon="Aim" @click="openResolve(row)">人工指认</el-button>
            <el-button size="small" :icon="RefreshRight" @click="retrySheet(row)">重试</el-button>
          </template>
          <span v-else class="gb-hint">已对观察员台账落账</span>
          <el-button size="small" type="danger" plain :icon="Delete" @click="removeSheet(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="pasteVisible" title="送达镜检复核单（一个批次）" width="680px" :close-on-click-modal="false">
      <p class="gb-hint">
        每行一张单，格式「样带编号,科名,观察体长段,复核体长段,标本号,结论[,类别]」；
        结论取 {{ REVIEW_VERDICTS.join(' / ') }}。示例：<br />
        <span class="gb-mono">T-02,隆头鱼科,11-20cm,21-30cm,SP-QL01B-01,改判体长段,鱼类</span><br />
        <span class="gb-mono">T-01,石斑鱼科,&gt;30cm,&gt;30cm,SP-QL02A-01,待复检,鱼类</span><br />
        <span class="gb-mono">T-09,鳞鲀科,11-20cm,11-20cm,SP-DZ01-SUS,符合,鱼类（对不上会挂起）</span>
      </p>
      <el-input v-model="pasteText" type="textarea" :rows="9" placeholder="T-02,隆头鱼科,11-20cm,21-30cm,SP-QL01B-01,改判体长段,鱼类" />
      <div v-if="pasteErrors.length > 0" class="page__errors">
        <el-alert v-for="(error, index) in pasteErrors" :key="index" type="warning" :title="error" :closable="false" show-icon />
      </div>
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button @click="previewPaste">解析预览</el-button>
        <el-button :disabled="!lastBatchId" :loading="submitting" @click="submitPaste(true)">
          同批重送（幂等）
        </el-button>
        <el-button type="primary" :loading="submitting" @click="submitPaste(false)">送达新批次</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="resolveVisible" title="挂起复核单 · 人工指认对账" width="620px">
      <p class="gb-hint" v-if="resolvingSheet">
        复核单：样带 {{ resolvingSheet.beltNo }} · {{ resolvingSheet.family }} · 标本号
        {{ resolvingSheet.specimenNo || '未编号' }} · {{ resolvingSheet.verdict }}。
        请选定观察员计数记录（fishes 那份保持不变，只回填对账关系并落账结论）。
      </p>
      <el-form label-width="120px">
        <el-form-item label="样带">
          <el-select v-model="resolveBeltId" placeholder="选择样带" style="width: 100%" @change="resolveFishId = ''">
            <el-option v-for="belt in candidateBelts" :key="belt.id" :label="belt.label" :value="belt.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="观察员计数行">
          <el-select v-model="resolveFishId" placeholder="选择计数记录" style="width: 100%" :disabled="!resolveBeltId">
            <el-option
              v-for="fish in candidateFishes"
              :key="fish.id"
              :label="fishOptionLabel(fish)"
              :value="fish.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resolveVisible = false">取消</el-button>
        <el-button type="primary" :icon="Connection" @click="confirmResolve">确认指认并落账</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.page__errors {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  max-height: 180px;
  overflow: auto;
}
</style>
