/**
 * 普查 store：维护珊瑚与鱼类筛选条件、录入草稿与覆盖度派生值。
 * 覆盖 /belts/:id/corals、/belts/:id/fishes 与 /coverage 三页。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { BleachLevel, CoralForm, CoralRecord } from '@/types/coralRecord'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { CountCategory, FishCount, ReviewStatus, SizeClass } from '@/types/fishCount'
import { countsIntoDensity } from '@/types/fishCount'
import type { FishReview, ReviewConclusion, ReviewPasteRow } from '@/types/fishReview'
import { conclusionToReviewStatus } from '@/types/fishReview'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 覆盖度汇总页筛选条件 */
export interface SurveyFilterState {
  keyword: string
  reefIds: string[]
  bleachLevels: BleachLevel[]
  /** 是否只看白化指数高于阈值的样带 */
  onlyBleached: boolean
}

export function createEmptySurveyFilter(): SurveyFilterState {
  return {
    keyword: '',
    reefIds: [],
    bleachLevels: [],
    onlyBleached: false
  }
}

/** 覆盖度汇总行 */
export interface CoverageSummaryRow {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  coverCmTotal: number
  coveragePct: number
  bleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  distribution: Record<BleachLevel, number>
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
  /** 待复核记录数：退回待复核的折算密度暂不进汇总 */
  pendingReviewCount: number
}

export const useSurveyStore = defineStore('survey', () => {
  const corals = ref<CoralRecord[]>([])
  const fishes = ref<FishCount[]>([])
  const fishReviews = ref<FishReview[]>([])
  const reefs = ref<Reef[]>([])
  const sites = ref<Site[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<SurveyFilterState>(createEmptySurveyFilter())
  /** 珊瑚录入草稿（跨页面保留） */
  const coralDraft = ref({
    genus: '',
    form: '枝状' as CoralForm,
    coverCm: 100,
    bleachLevel: '无' as BleachLevel,
    remark: ''
  })
  /** 鱼类计数草稿 */
  const fishDraft = ref({
    family: '',
    count: 1,
    sizeClass: '11-20cm' as SizeClass,
    category: '鱼类' as CountCategory
  })

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<CoralRecord>(() => db.corals).subscribe((rows) => {
      corals.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<FishCount>(() => db.fishes).subscribe((rows) => {
      fishes.value = rows
    })
    watchTable<FishReview>(() => db.fishReviews).subscribe((rows) => {
      fishReviews.value = rows
    })
    watchTable<Reef>(() => db.reefs).subscribe((rows) => {
      reefs.value = rows
    })
    watchTable<Site>(() => db.sites).subscribe((rows) => {
      sites.value = rows
    })
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
    })
  }

  /** 某样带的珊瑚记录（按白化等级降序、覆盖长度降序） */
  function coralsOfBelt(beltId: string | null | undefined): CoralRecord[] {
    if (!beltId) return []
    const order: Record<BleachLevel, number> = { 无: 0, 轻: 1, 中: 2, 重: 3, 死亡: 4 }
    return corals.value
      .filter((coral) => coral.beltId === beltId)
      .sort((a, b) => {
        const diff = order[b.bleachLevel] - order[a.bleachLevel]
        if (diff !== 0) return diff
        return b.coverCm - a.coverCm
      })
  }

  /** 某样带的鱼类/无脊椎动物计数 */
  function fishesOfBelt(beltId: string | null | undefined): FishCount[] {
    if (!beltId) return []
    return fishes.value
      .filter((fish) => fish.beltId === beltId)
      .sort((a, b) => b.count - a.count)
  }

  /** 某样带计入密度汇总的计数：退回待复核的先不进汇总 */
  function densityFishesOfBelt(beltId: string | null | undefined): FishCount[] {
    return fishesOfBelt(beltId).filter(countsIntoDensity)
  }

  /** 样带 id → 珊瑚记录数 / 鱼类记录数（样带列表回显用） */
  const beltRecordCounts = computed<Record<string, { coralCount: number; fishCount: number }>>(() => {
    const counts: Record<string, { coralCount: number; fishCount: number }> = {}
    belts.value.forEach((belt) => {
      counts[belt.id] = {
        coralCount: corals.value.filter((coral) => coral.beltId === belt.id).length,
        fishCount: fishes.value.filter((fish) => fish.beltId === belt.id).length
      }
    })
    return counts
  })

  /** 覆盖度汇总行（全部样带） */
  const coverageRows = computed<CoverageSummaryRow[]>(() =>
    belts.value
      .map((belt) => {
        const site = sites.value.find((item) => item.id === belt.siteId)
        const reef = site ? reefs.value.find((item) => item.id === site.reefId) : undefined
        const beltCorals = corals.value.filter((coral) => coral.beltId === belt.id)
        const beltFishes = fishes.value.filter((fish) => fish.beltId === belt.id)
        const coverCmTotal = round(
          beltCorals.reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
        const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
        BLEACH_LEVELS.forEach((level) => {
          distribution[level] = round(
            beltCorals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
            1
          )
        })
        const index = bleachIndex(beltCorals)
        const fishTotal = beltFishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
        // 折算密度只计非待复核的记录：退回待复核的先不进汇总，待实验室复核后恢复
        const densityFishes = beltFishes.filter(countsIntoDensity)
        const densityFishTotal = densityFishes
          .filter((fish) => fish.category === '鱼类')
          .reduce((sum, fish) => sum + fish.count, 0)
        return {
          beltId: belt.id,
          beltNo: belt.no,
          reefId: reef?.id ?? '',
          reefName: reef?.name ?? '未知礁区',
          siteId: site?.id ?? '',
          siteNo: site?.no ?? '—',
          lengthM: belt.lengthM,
          orientation: belt.orientation,
          surveyDate: belt.surveyDate,
          observer: belt.observer,
          coralCount: beltCorals.length,
          coverCmTotal,
          coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
          bleachIndex: index,
          grade: bleachGrade(index),
          bleachedSharePct: bleachedSharePct(beltCorals),
          distribution,
          fishTotal,
          invertebrateTotal: beltFishes
            .filter((fish) => fish.category === '无脊椎动物')
            .reduce((sum, fish) => sum + fish.count, 0),
          fishDensity: fishDensity(densityFishTotal, belt.lengthM),
          pendingReviewCount: beltFishes.length - densityFishes.length
        }
      })
      .sort((a, b) => b.bleachIndex - a.bleachIndex)
  )

  /** 按筛选条件过滤后的覆盖度行 */
  const filteredCoverageRows = computed<CoverageSummaryRow[]>(() =>
    coverageRows.value.filter((row) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.reefName}${row.siteNo}${row.beltNo}${row.observer}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.reefIds.length > 0 && !filter.value.reefIds.includes(row.reefId)) return false
      if (filter.value.bleachLevels.length > 0) {
        const matched = filter.value.bleachLevels.some((level) => row.distribution[level] > 0)
        if (!matched) return false
      }
      if (filter.value.onlyBleached && row.bleachedSharePct <= 0) return false
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.reefIds.length > 0 ||
      filter.value.bleachLevels.length > 0 ||
      filter.value.onlyBleached
  )

  /** 全局白化等级分布与总体指数 */
  const globalStats = computed(() => {
    const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
    BLEACH_LEVELS.forEach((level) => {
      distribution[level] = round(
        corals.value.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
    })
    const index = bleachIndex(corals.value)
    return {
      coralCount: corals.value.length,
      fishCount: fishes.value.length,
      coverCmTotal: round(
        corals.value.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      ),
      bleachIndex: index,
      grade: bleachGrade(index),
      bleachedSharePct: bleachedSharePct(corals.value),
      distribution
    }
  })

  function patchFilter(patch: Partial<SurveyFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptySurveyFilter()
  }

  function patchCoralDraft(patch: Partial<typeof coralDraft.value>): void {
    coralDraft.value = { ...coralDraft.value, ...patch }
  }

  function patchFishDraft(patch: Partial<typeof fishDraft.value>): void {
    fishDraft.value = { ...fishDraft.value, ...patch }
  }

  /* ------------------------------ 珊瑚记录 ------------------------------ */

  async function createCoral(
    beltId: string,
    payload: Omit<CoralRecord, 'id' | 'createdAt' | 'updatedAt' | 'beltId'>
  ): Promise<CoralRecord> {
    const now = Date.now()
    const row: CoralRecord = { ...payload, beltId, id: createId('cor'), createdAt: now, updatedAt: now }
    await db.corals.put(row)
    return row
  }

  async function updateCoral(id: string, patch: Partial<CoralRecord>): Promise<void> {
    await db.corals.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeCoral(id: string): Promise<void> {
    await db.corals.delete(id)
  }

  /** 批量导入粘贴行（替换该样带原有珊瑚记录） */
  async function importCoralRows(
    beltId: string,
    rows: Array<{ genus: string; form: CoralForm; coverCm: number; bleachLevel: BleachLevel }>
  ): Promise<number> {
    const now = Date.now()
    const records: CoralRecord[] = rows.map((row, index) => ({
      id: createId('cor'),
      beltId,
      genus: row.genus,
      form: row.form,
      coverCm: row.coverCm,
      bleachLevel: row.bleachLevel,
      remark: '',
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.transaction('rw', [db.corals], async () => {
      await db.corals.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.corals.bulkPut(records)
    })
    return records.length
  }

  /** 批量改写白化等级 */
  async function bulkSetBleachLevel(ids: string[], bleachLevel: BleachLevel): Promise<number> {
    const now = Date.now()
    await db.corals
      .where('id')
      .anyOf(ids)
      .modify((coral) => {
        coral.bleachLevel = bleachLevel
        coral.updatedAt = now
      })
    return ids.length
  }

  /* ------------------------------ 鱼类计数（观察员那份） ------------------------------ */

  async function createFish(
    beltId: string,
    payload: Omit<FishCount, 'id' | 'createdAt' | 'updatedAt' | 'beltId' | 'reviewStatus'>
  ): Promise<FishCount> {
    const now = Date.now()
    // 新录计数一律待复核：待实验室复核单对上后，折算密度才进汇总
    const row: FishCount = { ...payload, reviewStatus: '待复核', beltId, id: createId('fsh'), createdAt: now, updatedAt: now }
    await db.fishes.put(row)
    return row
  }

  /**
   * 观察员改计数记录。实验室标过待复检（或已复核）后，再动数量或体长段 → 退回待复核，
   * 折算密度暂不进汇总；返回是否发生了退回。
   */
  async function updateFish(id: string, patch: Partial<FishCount>): Promise<boolean> {
    const current = await db.fishes.get(id)
    if (!current) return false
    const measureTouched =
      (patch.count !== undefined && patch.count !== current.count) ||
      (patch.sizeClass !== undefined && patch.sizeClass !== current.sizeClass)
    const bounced = measureTouched && current.reviewStatus !== '待复核'
    const next: Partial<FishCount> = { ...patch, updatedAt: Date.now() }
    if (bounced) next.reviewStatus = '待复核'
    await db.fishes.update(id, next as never)
    return bounced
  }

  async function removeFish(id: string): Promise<void> {
    await db.fishes.delete(id)
  }

  /** 批量导入粘贴行（替换该样带原有计数；新行一律待复核） */
  async function importFishRows(
    beltId: string,
    rows: Array<{ family: string; count: number; sizeClass: SizeClass; category: CountCategory }>
  ): Promise<number> {
    const now = Date.now()
    const records: FishCount[] = rows.map((row, index) => ({
      id: createId('fsh'),
      beltId,
      family: row.family,
      count: row.count,
      sizeClass: row.sizeClass,
      category: row.category,
      reviewStatus: '待复核',
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.transaction('rw', [db.fishes], async () => {
      await db.fishes.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.fishes.bulkPut(records)
    })
    return records.length
  }

  /** 按科名与体长段汇总某样带计数 */
  function fishSummaryOfBelt(beltId: string | null | undefined): Array<{
    family: string
    category: CountCategory
    total: number
    bySize: Record<SizeClass, number>
  }> {
    if (!beltId) return []
    const map = new Map<string, { family: string; category: CountCategory; total: number; bySize: Record<SizeClass, number> }>()
    fishesOfBelt(beltId).forEach((fish) => {
      const bucket =
        map.get(fish.family) ??
        { family: fish.family, category: fish.category, total: 0, bySize: { '0-10cm': 0, '11-20cm': 0, '21-30cm': 0, '>30cm': 0 } }
      bucket.total += fish.count
      bucket.bySize[fish.sizeClass] += fish.count
      map.set(fish.family, bucket)
    })
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  }

  /* ------------------------------ 镜检复核单（实验室那份） ------------------------------ */

  /** 该样带已对上的复核单（标本号与复核结论只认实验室这份，观察员侧只读展示） */
  function reviewsOfBelt(beltId: string | null | undefined): FishReview[] {
    if (!beltId) return []
    const fishIds = new Set(fishesOfBelt(beltId).map((fish) => fish.id))
    return fishReviews.value
      .filter((review) => review.fishId !== null && fishIds.has(review.fishId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 计数记录 id → 最新一张已对上的复核单（观察员页回显标本号 / 结论用） */
  const latestReviewByFishId = computed<Map<string, FishReview>>(() => {
    const map = new Map<string, FishReview>()
    fishReviews.value.forEach((review) => {
      if (review.fishId === null) return
      const existing = map.get(review.fishId)
      if (!existing || existing.updatedAt < review.updatedAt) map.set(review.fishId, review)
    })
    return map
  })

  /** 复核单按批次汇总（复核单台账页批次列表用） */
  const reviewBatches = computed(() => {
    const map = new Map<string, { batchId: string; total: number; matched: number; suspended: number; updatedAt: number }>()
    fishReviews.value.forEach((review) => {
      const bucket =
        map.get(review.batchId) ?? { batchId: review.batchId, total: 0, matched: 0, suspended: 0, updatedAt: 0 }
      bucket.total += 1
      if (review.reconStatus === '已对上') bucket.matched += 1
      else bucket.suspended += 1
      bucket.updatedAt = Math.max(bucket.updatedAt, review.updatedAt)
      map.set(review.batchId, bucket)
    })
    return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  })

  /** 按「样带编号 + 科名」对账：唯一命中才入账，无命中或多次命中都挂起等人定 */
  function matchFishForReview(sheet: { beltNo: string; family: string }, allFishes: FishCount[], allBelts: Belt[]): FishCount | null {
    const beltIds = new Set(allBelts.filter((belt) => belt.no === sheet.beltNo).map((belt) => belt.id))
    const matches = allFishes.filter((fish) => beltIds.has(fish.beltId) && fish.family === sheet.family)
    return matches.length === 1 ? matches[0] : null
  }

  /** 应用复核结论到观察员那份：只推进复核状态，数量与体长段归观察员，实验室不碰 */
  async function applyConclusion(fishId: string, conclusion: ReviewConclusion, now: number): Promise<void> {
    await db.fishes.update(fishId, { reviewStatus: conclusionToReviewStatus(conclusion), updatedAt: now } as never)
  }

  /**
   * 送检一批复核单：同一批复核单重送按「批次号 + 标本号」去重，不多出结论；
   * 新单立即按「样带编号 + 科名」对账，对不上的挂起等人定。
   */
  async function importReviewBatch(
    batchId: string,
    rows: ReviewPasteRow[]
  ): Promise<{ added: number; skipped: number; matched: number; suspended: number }> {
    const now = Date.now()
    return await db.transaction('rw', [db.fishReviews, db.fishes, db.belts], async () => {
      const existing = await db.fishReviews.where('batchId').equals(batchId).toArray()
      const seen = new Set(existing.map((review) => review.specimenNo))
      const allFishes = await db.fishes.toArray()
      const allBelts = await db.belts.toArray()
      const sheets: FishReview[] = []
      const conclusionByFishId = new Map<string, ReviewConclusion>()
      let skipped = 0
      rows.forEach((row, index) => {
        if (seen.has(row.specimenNo)) {
          skipped += 1
          return
        }
        seen.add(row.specimenNo)
        const fish = matchFishForReview(row, allFishes, allBelts)
        sheets.push({
          id: createId('frv'),
          batchId,
          beltNo: row.beltNo,
          family: row.family,
          specimenNo: row.specimenNo,
          reviewedSizeClass: row.reviewedSizeClass,
          conclusion: row.conclusion,
          reconStatus: fish ? '已对上' : '挂起',
          fishId: fish?.id ?? null,
          note: row.note,
          createdAt: now + index,
          updatedAt: now + index
        })
        if (fish) conclusionByFishId.set(fish.id, row.conclusion)
      })
      if (sheets.length > 0) await db.fishReviews.bulkPut(sheets)
      for (const [fishId, conclusion] of conclusionByFishId) {
        await applyConclusion(fishId, conclusion, now)
      }
      const matched = sheets.filter((sheet) => sheet.reconStatus === '已对上').length
      return { added: sheets.length, skipped, matched, suspended: sheets.length - matched }
    })
  }

  /** 对账失败后只重试实验室这份：重跑挂起复核单的匹配，观察员计数记录照旧 */
  async function retrySuspendedReviews(): Promise<{ matched: number; suspended: number }> {
    const now = Date.now()
    return await db.transaction('rw', [db.fishReviews, db.fishes, db.belts], async () => {
      const suspended = await db.fishReviews.where('reconStatus').equals('挂起').toArray()
      const allFishes = await db.fishes.toArray()
      const allBelts = await db.belts.toArray()
      let matched = 0
      for (const sheet of suspended) {
        const fish = matchFishForReview(sheet, allFishes, allBelts)
        if (!fish) continue
        matched += 1
        await db.fishReviews.update(sheet.id, { reconStatus: '已对上', fishId: fish.id, updatedAt: now } as never)
        await applyConclusion(fish.id, sheet.conclusion, now)
      }
      return { matched, suspended: suspended.length - matched }
    })
  }

  /** 人工定夺挂起复核单：指定观察员计数记录入账，并应用复核结论 */
  async function resolveSuspendedReview(reviewId: string, fishId: string): Promise<void> {
    const now = Date.now()
    await db.transaction('rw', [db.fishReviews, db.fishes], async () => {
      const sheet = await db.fishReviews.get(reviewId)
      if (!sheet || sheet.reconStatus !== '挂起') return
      await db.fishReviews.update(reviewId, { reconStatus: '已对上', fishId, updatedAt: now } as never)
      await applyConclusion(fishId, sheet.conclusion, now)
    })
  }

  /** 作废挂起复核单：尚未入账，不影响观察员那份 */
  async function discardSuspendedReview(reviewId: string): Promise<void> {
    const sheet = await db.fishReviews.get(reviewId)
    if (sheet && sheet.reconStatus === '挂起') await db.fishReviews.delete(reviewId)
  }

  return {
    corals,
    fishes,
    fishReviews,
    reefs,
    sites,
    belts,
    ready,
    error,
    filter,
    coralDraft,
    fishDraft,
    beltRecordCounts,
    coverageRows,
    filteredCoverageRows,
    hasFilter,
    globalStats,
    latestReviewByFishId,
    reviewBatches,
    start,
    coralsOfBelt,
    fishesOfBelt,
    densityFishesOfBelt,
    reviewsOfBelt,
    fishSummaryOfBelt,
    patchFilter,
    resetFilter,
    patchCoralDraft,
    patchFishDraft,
    createCoral,
    updateCoral,
    removeCoral,
    importCoralRows,
    bulkSetBleachLevel,
    createFish,
    updateFish,
    removeFish,
    importFishRows,
    importReviewBatch,
    retrySuspendedReviews,
    resolveSuspendedReview,
    discardSuspendedReview
  }
})
