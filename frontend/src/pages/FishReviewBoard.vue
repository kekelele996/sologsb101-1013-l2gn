<script setup lang="ts">
/**
 * 模块 7：/fish-reviews 镜检复核单台账（实验室那份）
 * 复核单归实验室：标本号与复核结论只认这份；按「样带编号 + 科名」与观察员计数对账，
 * 对不上的挂起等人定；对账失败只重试实验室这份，观察员计数照旧；
 * 同一批复核单重送按「批次号 + 标本号」去重，不多出结论。
 * 复用 <StatBadge>、<EmptyPanel>。
 */
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DocumentCopy, Refresh } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useSurveyStore } from '@/stores/surveyStore'
import { parseReviewPaste, RECON_STATUSES } from '@/types/fishReview'
import type { FishReview, ReconStatus } from '@/types/fishReview'

const surveyStore = useSurveyStore()

const pasteVisible = ref(false)
const batchId = ref('')
const pasteText = ref('')
const pasteErrors = ref<string[]>([])
const submitting = ref(false)
const batchFilter = ref<string>('全部')
const reconFilter = ref<ReconStatus | '全部'>('全部')
const resolveVisible = ref(false)
const resolvingReview = ref<FishReview | null>(null)
const resolveFishId = ref<string>('')

const reviews = computed(() =>
  surveyStore.fishReviews
    .filter((review) => batchFilter.value === '全部' || review.batchId === batchFilter.value)
    .filter((review) => reconFilter.value === '全部' || review.reconStatus === reconFilter.value)
    .sort((a, b) => b.updatedAt - a.updatedAt)
)

const stats = computed(() => ({
  batches: surveyStore.reviewBatches.length,
  total: surveyStore.fishReviews.length,
  matched: surveyStore.fishReviews.filter((review) => review.reconStatus === '已对上').length,
  suspended: surveyStore.fishReviews.filter((review) => review.reconStatus === '挂起').length
}))

/** 样带 id → 样带编号（对账键回显用） */
const beltNoById = computed(() => new Map(surveyStore.belts.map((belt) => [belt.id, belt.no])))

/** 复核单关联的观察员计数记录回显 */
function fishLabel(fishId: string | null): string {
  if (fishId === null) return '—'
  const fish = surveyStore.fishes.find((item) => item.id === fishId)
  if (!fish) return '计数记录已删除'
  return `${fish.family} ${fish.sizeClass} × ${fish.count}`
}

/** 人工入账候选：全部观察员计数记录，按样带编号 + 科名标注 */
const fishOptions = computed(() =>
  surveyStore.fishes.map((fish) => ({
    value: fish.id,
    label: `样带 ${beltNoById.value.get(fish.beltId) ?? '?'} · ${fish.family} · ${fish.sizeClass} · ${fish.count} 尾/个`
  }))
)

function reconTagType(status: ReconStatus): 'success' | 'warning' {
  return status === '已对上' ? 'success' : 'warning'
}

function openPaste(): void {
  batchId.value = `RB-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
  pasteText.value = ''
  pasteErrors.value = []
  pasteVisible.value = true
}

function previewPaste(): void {
  const parsed = parseReviewPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0 && parsed.errors.length === 0) {
    ElMessage.warning('请先粘贴内容，每行格式「样带编号,科名,标本号,复核体长段,结论[,备注]」')
  }
}

async function importPaste(): Promise<void> {
  const trimmedBatchId = batchId.value.trim()
  if (!trimmedBatchId) {
    ElMessage.warning('请填写送检批次号')
    return
  }
  const parsed = parseReviewPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0) {
    ElMessage.warning('没有可送检的有效行')
    return
  }
  submitting.value = true
  try {
    const result = await surveyStore.importReviewBatch(trimmedBatchId, parsed.rows)
    pasteVisible.value = false
    ElMessage.success(
      `批次 ${trimmedBatchId} 入账 ${result.added} 张（已对上 ${result.matched}、挂起 ${result.suspended}）` +
        (result.skipped > 0 ? `，同一批复核单重送跳过 ${result.skipped} 张` : '')
    )
  } finally {
    submitting.value = false
  }
}

/** 对账重试：只重试实验室这份（挂起的复核单），观察员计数照旧 */
async function retryRecon(): Promise<void> {
  const result = await surveyStore.retrySuspendedReviews()
  if (result.matched === 0 && result.suspended === 0) {
    ElMessage.info('没有挂起的复核单需要重试')
    return
  }
  ElMessage.success(`对账重试完成（仅实验室这份，观察员计数照旧）：新对上 ${result.matched} 张，仍挂起 ${result.suspended} 张`)
}

function openResolve(review: FishReview): void {
  resolvingReview.value = review
  resolveFishId.value = ''
  resolveVisible.value = true
}

async function submitResolve(): Promise<void> {
  if (!resolvingReview.value) return
  if (!resolveFishId.value) {
    ElMessage.warning('请选择要对上的观察员计数记录')
    return
  }
  await surveyStore.resolveSuspendedReview(resolvingReview.value.id, resolveFishId.value)
  resolveVisible.value = false
  ElMessage.success('已人工入账，复核结论已应用到该计数记录')
}

async function discard(review: FishReview): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `作废标本号「${review.specimenNo}」的挂起复核单？该单尚未入账，不影响观察员计数。`,
      '作废确认',
      { type: 'warning', confirmButtonText: '作废', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await surveyStore.discardSuspendedReview(review.id)
  ElMessage.success('挂起复核单已作废')
}
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">镜检复核单台账 · 实验室</h2>
        <p class="gb-hint">
          复核单归实验室，标本号与复核结论只认这份；按「样带编号 + 科名」与观察员计数对账，对不上的挂起等人定；
          同一批复核单重送不多出结论，对账重试只动实验室这份，观察员计数照旧。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="Refresh" :disabled="stats.suspended === 0" @click="retryRecon">
          重试对账（仅实验室这份）
        </el-button>
        <el-button type="primary" :icon="DocumentCopy" @click="openPaste">批量粘贴送检</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="送检批次" :value="stats.batches" suffix="批" icon="Files" />
      <StatBadge label="复核单" :value="stats.total" suffix="张" tone="info" icon="Histogram" />
      <StatBadge label="已对上" :value="stats.matched" suffix="张" tone="success" icon="DataLine" />
      <StatBadge label="挂起待定" :value="stats.suspended" suffix="张" tone="warning" icon="WarningFilled" />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>按批次汇总</h3>
        <span class="gb-hint">同一批复核单重送按「批次号 + 标本号」去重，不多出结论</span>
      </div>
      <el-table :data="surveyStore.reviewBatches" border size="small" class="gb-table-compact">
        <el-table-column label="批次号" min-width="150">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.batchId }}</span>
          </template>
        </el-table-column>
        <el-table-column label="复核单" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.total }} 张</span>
          </template>
        </el-table-column>
        <el-table-column label="已对上" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.matched }} 张</span>
          </template>
        </el-table-column>
        <el-table-column label="挂起" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono" :class="{ 'gb-danger': row.suspended > 0 }">{{ row.suspended }} 张</span>
          </template>
        </el-table-column>
        <el-table-column label="最近更新" min-width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.updatedAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无送检批次" description="点击右上角「批量粘贴送检」录入第一批复核单。" compact />
        </template>
      </el-table>
    </el-card>

    <div class="page__filter">
      <span class="gb-hint">批次筛选：</span>
      <el-select v-model="batchFilter" size="small" style="width: 180px">
        <el-option label="全部批次" value="全部" />
        <el-option v-for="batch in surveyStore.reviewBatches" :key="batch.batchId" :label="batch.batchId" :value="batch.batchId" />
      </el-select>
      <span class="gb-hint">对账状态：</span>
      <el-radio-group v-model="reconFilter" size="small">
        <el-radio-button value="全部">全部</el-radio-button>
        <el-radio-button v-for="status in RECON_STATUSES" :key="status" :value="status">{{ status }}</el-radio-button>
      </el-radio-group>
    </div>

    <EmptyPanel
      v-if="reviews.length === 0"
      title="没有符合条件的复核单"
      description="实验室按批次粘贴送检复核单，系统自动按「样带编号 + 科名」与观察员计数对账。"
      action-text="批量粘贴送检"
      @action="openPaste"
    />

    <el-table v-else :data="reviews" border stripe class="gb-table-compact">
      <el-table-column label="批次号" width="130">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.batchId }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="beltNo" label="样带编号" width="90" />
      <el-table-column prop="family" label="科名" min-width="110" />
      <el-table-column label="标本号" min-width="130">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.specimenNo }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="reviewedSizeClass" label="复核体长段" width="100" />
      <el-table-column label="复核结论" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.conclusion === '确认' ? 'success' : 'danger'" effect="plain">
            {{ row.conclusion }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="对账状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="reconTagType(row.reconStatus)" effect="plain">{{ row.reconStatus }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="关联计数（观察员那份）" min-width="170">
        <template #default="{ row }">
          <span class="gb-hint">{{ fishLabel(row.fishId) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip />
      <el-table-column label="操作" width="160" fixed="right">
        <template #default="{ row }">
          <template v-if="row.reconStatus === '挂起'">
            <el-button size="small" type="primary" plain @click="openResolve(row)">人工入账</el-button>
            <el-button size="small" type="danger" plain @click="discard(row)">作废</el-button>
          </template>
          <span v-else class="gb-hint">已入账</span>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="pasteVisible" title="批量粘贴送检复核单" width="640px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="送检批次号" required>
          <el-input v-model="batchId" placeholder="如 RB-20261003" maxlength="30" />
          <div class="gb-hint">同一批复核单重送时按「批次号 + 标本号」去重，不多出结论</div>
        </el-form-item>
        <el-form-item label="复核单内容" required>
          <el-input v-model="pasteText" type="textarea" :rows="8" placeholder="T-01,石斑鱼科,QL2-T01-B01,>30cm,确认" />
        </el-form-item>
      </el-form>
      <p class="gb-hint">
        每行一张，格式「样带编号,科名,标本号,复核体长段,结论[,备注]」，逗号 / 制表符 / 分号均可，结论为 确认 / 待复检。示例：<br />
        <span class="gb-mono">T-01,石斑鱼科,QL2-T01-B01,&gt;30cm,确认</span><br />
        <span class="gb-mono">T-02,隆头鱼科,QL-T02-B03,21-30cm,待复检,镜检体长段与船上记录不符</span>
      </p>
      <div v-if="pasteErrors.length > 0" class="page__errors">
        <el-alert v-for="(error, index) in pasteErrors" :key="index" type="warning" :title="error" :closable="false" show-icon />
      </div>
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button @click="previewPaste">解析预览</el-button>
        <el-button type="primary" :loading="submitting" @click="importPaste">送检入账</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="resolveVisible" title="人工入账挂起复核单" width="560px" :close-on-click-modal="false">
      <template v-if="resolvingReview">
        <el-descriptions :column="2" border size="small" class="page__resolve-info">
          <el-descriptions-item label="标本号">{{ resolvingReview.specimenNo }}</el-descriptions-item>
          <el-descriptions-item label="批次号">{{ resolvingReview.batchId }}</el-descriptions-item>
          <el-descriptions-item label="样带编号">{{ resolvingReview.beltNo }}</el-descriptions-item>
          <el-descriptions-item label="科名">{{ resolvingReview.family }}</el-descriptions-item>
          <el-descriptions-item label="复核体长段">{{ resolvingReview.reviewedSizeClass }}</el-descriptions-item>
          <el-descriptions-item label="复核结论">{{ resolvingReview.conclusion }}</el-descriptions-item>
        </el-descriptions>
        <el-form label-width="104px">
          <el-form-item label="计数记录" required>
            <el-select v-model="resolveFishId" filterable placeholder="选择要对上的观察员计数记录" style="width: 100%">
              <el-option v-for="option in fishOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </el-form-item>
        </el-form>
        <p class="gb-hint">人工入账后复核结论立即应用到该计数记录；此操作只动实验室这份的挂起单，观察员计数内容照旧。</p>
      </template>
      <template #footer>
        <el-button @click="resolveVisible = false">取消</el-button>
        <el-button type="primary" @click="submitResolve">确认入账</el-button>
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
  margin: 0 0 4px;
  font-size: 19px;
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
  max-height: 160px;
  overflow: auto;
}

.page__resolve-info {
  margin-bottom: 14px;
}
</style>
