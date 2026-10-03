/**
 * 普查 store：维护珊瑚与鱼类筛选条件、录入草稿与覆盖度派生值。
 * 覆盖 /belts/:id/corals、/belts/:id/fishes、/lab/reviews 与 /coverage 四页。
 *
 * 分账口径：
 * - fishes 是观察员计数台账，新建/补记默认「待复核」；待复检记录再被改动
 *   数量或体长段后退回「待复核」；
 * - labReviews 是实验室镜检复核单，标本号 / 复核体长段 / 复核结论只认实验室这份；
 * - 折算密度与汇总只取「已复核」计数，体长段以实验室改判为准。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { BleachLevel, CoralForm, CoralRecord } from '@/types/coralRecord'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { CountCategory, FishCount, FishReviewStatus, SizeClass } from '@/types/fishCount'
import type { LabReviewInput, LabReviewSheet } from '@/types/labReview'
import { createBatchId, reviewSheetId, verdictToStatus } from '@/types/labReview'
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
  /** 尚未进汇总的计数（待复核 / 待复检）尾数，供页面提示 */
  pendingFishTotal: number
}

/** 对账结果：命中唯一观察员记录，或挂起原因 */
interface ReconcileMatch {
  beltId: string | null
  fishId: string | null
}

export const useSurveyStore = defineStore('survey', () => {
  const corals = ref<CoralRecord[]>([])
  const fishes = ref<FishCount[]>([])
  const labReviews = ref<LabReviewSheet[]>([])
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
    watchTable<LabReviewSheet>(() => db.labReviews).subscribe((rows) => {
      labReviews.value = rows
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

  /** 某样带的鱼类/无脊椎动物计数（观察员台账，按数量降序） */
  function fishesOfBelt(beltId: string | null | undefined): FishCount[] {
    if (!beltId) return []
    return fishes.value
      .filter((fish) => fish.beltId === beltId)
      .sort((a, b) => b.count - a.count)
  }

  /**
   * 计数记录当前生效体长段：已复核记录以实验室复核单改判为准；
   * 待复核 / 待复检没有落账结论，仍用观察员记录值。
   */
  function effectiveSizeClass(fish: FishCount): SizeClass {
    if (fish.reviewStatus !== '已复核') return fish.sizeClass
    const sheet = labReviews.value.find(
      (item) => item.fishId === fish.id && item.status === '已复核'
    )
    return sheet?.reviewedSizeClass ?? fish.sizeClass
  }

  /** 某条计数对应的实验室复核单（标本号 / 结论只从这里取） */
  function reviewOfFish(fishId: string): LabReviewSheet | null {
    return labReviews.value.find((sheet) => sheet.fishId === fishId) ?? null
  }

  /** 参与密度折算与汇总的计数（仅已复核） */
  function includedFishes(list: FishCount[]): FishCount[] {
    return list.filter((fish) => fish.reviewStatus === '已复核')
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

  /** 覆盖度汇总行（全部样带；密度只算已复核计数） */
  const coverageRows = computed<CoverageSummaryRow[]>(() =>
    belts.value
      .map((belt) => {
        const site = sites.value.find((item) => item.id === belt.siteId)
        const reef = site ? reefs.value.find((item) => item.id === site.reefId) : undefined
        const beltCorals = corals.value.filter((coral) => coral.beltId === belt.id)
        const beltFishes = fishes.value.filter((fish) => fish.beltId === belt.id)
        const countedFishes = includedFishes(beltFishes)
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
        const fishTotal = countedFishes
          .filter((fish) => fish.category === '鱼类')
          .reduce((sum, fish) => sum + fish.count, 0)
        const pendingFishTotal = beltFishes
          .filter((fish) => fish.reviewStatus !== '已复核')
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
          invertebrateTotal: countedFishes
            .filter((fish) => fish.category === '无脊椎动物')
            .reduce((sum, fish) => sum + fish.count, 0),
          fishDensity: fishDensity(fishTotal, belt.lengthM),
          pendingFishTotal
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

  /* ------------------------ 观察员鱼类计数（fishes） ------------------------ */

  async function createFish(
    beltId: string,
    payload: Omit<FishCount, 'id' | 'createdAt' | 'updatedAt' | 'beltId' | 'reviewStatus'>
  ): Promise<FishCount> {
    const now = Date.now()
    const row: FishCount = {
      ...payload,
      beltId,
      reviewStatus: '待复核',
      id: createId('fsh'),
      createdAt: now,
      updatedAt: now
    }
    await db.fishes.put(row)
    return row
  }

  /**
   * 观察员更新计数：数量或体长段被实际改动时，待复检 / 已复核记录退回「待复核」，
   * 折算密度随即撤出汇总；仅改类别等其他字段不退回。
   */
  async function updateFish(id: string, patch: Partial<FishCount>): Promise<void> {
    const current = await db.fishes.get(id)
    const next: Partial<FishCount> = { ...patch, updatedAt: Date.now() }
    if (current) {
      const countChanged = patch.count !== undefined && patch.count !== current.count
      const sizeChanged = patch.sizeClass !== undefined && patch.sizeClass !== current.sizeClass
      if ((countChanged || sizeChanged) && current.reviewStatus !== '待复核') {
        next.reviewStatus = '待复核'
      }
    }
    await db.fishes.update(id, next as never)
  }

  /**
   * 删除观察员记录：不触碰实验室那份，只把仍挂在该记录上的复核单置为挂起，
   * 等人重新对账（观察员台账已不存在，结论先挂起）。
   */
  async function removeFish(id: string): Promise<void> {
    await db.transaction('rw', [db.fishes, db.labReviews], async () => {
      await db.fishes.delete(id)
      await db.labReviews
        .where('fishId')
        .equals(id)
        .modify((sheet: LabReviewSheet) => {
          if (sheet.status !== '挂起') {
            sheet.status = '挂起'
            sheet.fishId = null
            sheet.updatedAt = Date.now()
          }
        })
    })
  }

  /** 批量导入粘贴行（替换该样带原有计数）；新行一律待复核 */
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
    await db.transaction('rw', [db.fishes, db.labReviews], async () => {
      const oldIds = (await db.fishes.where('beltId').equals(beltId).toArray()).map((fish) => fish.id)
      if (oldIds.length > 0) {
        await db.labReviews
          .where('fishId')
          .anyOf(oldIds)
          .modify((sheet: LabReviewSheet) => {
            if (sheet.status !== '挂起') {
              sheet.status = '挂起'
              sheet.fishId = null
              sheet.updatedAt = now
            }
          })
      }
      await db.fishes.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.fishes.bulkPut(records)
    })
    return records.length
  }

  /** 按科名与生效体长段汇总某样带计数（仅已复核，体长段以实验室改判为准） */
  function fishSummaryOfBelt(beltId: string | null | undefined): Array<{
    family: string
    category: CountCategory
    total: number
    bySize: Record<SizeClass, number>
  }> {
    if (!beltId) return []
    const map = new Map<string, { family: string; category: CountCategory; total: number; bySize: Record<SizeClass, number> }>()
    includedFishes(fishesOfBelt(beltId)).forEach((fish) => {
      const sizeClass = effectiveSizeClass(fish)
      const bucket =
        map.get(fish.family) ??
        { family: fish.family, category: fish.category, total: 0, bySize: { '0-10cm': 0, '11-20cm': 0, '21-30cm': 0, '>30cm': 0 } }
      bucket.total += fish.count
      bucket.bySize[sizeClass] += fish.count
      map.set(fish.family, bucket)
    })
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  }

  /* -------------------- 实验室镜检复核单（labReviews） -------------------- */

  /**
   * 按样带编号 + 科名与观察员台账对账：
   * 样带编号不唯一或同科多条无法唯一定位时返回空，交人工裁定。
   */
  function reconcile(input: Pick<LabReviewInput, 'beltNo' | 'family'>): ReconcileMatch {
    const candidateBelts = belts.value.filter((belt) => belt.no === input.beltNo.trim())
    if (candidateBelts.length !== 1) return { beltId: null, fishId: null }
    const beltId = candidateBelts[0].id
    const candidateFishes = fishes.value.filter(
      (fish) => fish.beltId === beltId && fish.family === input.family.trim()
    )
    if (candidateFishes.length !== 1) return { beltId: null, fishId: null }
    return { beltId, fishId: candidateFishes[0].id }
  }

  /**
   * 送达一批复核单：按「批次号 + 样带编号 + 科名 + 标本号」幂等落账。
   * 同批复核单重送只更新原单，不多出结论；原单挂起的仅重试实验室这份，
   * 观察员那份保持不动。
   */
  async function ingestReviewBatch(
    rows: LabReviewInput[],
    batchId = createBatchId()
  ): Promise<{ batchId: string; created: number; updated: number; suspended: number }> {
    let created = 0
    let updated = 0
    let suspended = 0
    const now = Date.now()
    await db.transaction('rw', [db.labReviews, db.fishes, db.belts], async () => {
      for (const row of rows) {
        const id = reviewSheetId(batchId, row)
        const existing = await db.labReviews.get(id)
        const targetStatus = verdictToStatus(row.verdict)
        if (existing) {
          // 重送：不新增结论。
          // - 原单挂起：只重试自己这份，命中则落账；
          // - 原单已落账：维持对账关系；仅当结论确实改了才同步观察员状态，
          //   同内容重送不重刷（观察员改动后退回的待复核不被悄悄翻回已复核）。
          const shouldRetry = existing.status === '挂起'
          const match = shouldRetry
            ? reconcile(row)
            : { beltId: existing.beltId, fishId: existing.fishId }
          const matched = match.beltId !== null && match.fishId !== null
          const verdictChanged = existing.verdict !== row.verdict || existing.status !== targetStatus
          await db.labReviews.put({
            ...existing,
            observerSizeClass: row.observerSizeClass,
            reviewedSizeClass: row.reviewedSizeClass,
            verdict: row.verdict,
            category: row.category,
            attempts: shouldRetry ? existing.attempts + 1 : existing.attempts,
            status: matched ? targetStatus : '挂起',
            beltId: matched ? match.beltId : existing.beltId,
            fishId: matched ? match.fishId : existing.fishId,
            updatedAt: now
          })
          // 仅「挂起重试命中」或「结论发生变化」时落结论到观察员记录
          if (matched && match.fishId && (shouldRetry || verdictChanged)) {
            await applyVerdictToFish(match.fishId, targetStatus)
          }
          updated += 1
          if (!matched) suspended += 1
        } else {
          const match = reconcile(row)
          const matched = match.beltId !== null && match.fishId !== null
          await db.labReviews.put({
            id,
            batchId,
            beltNo: row.beltNo.trim(),
            family: row.family.trim(),
            observerSizeClass: row.observerSizeClass,
            reviewedSizeClass: row.reviewedSizeClass,
            specimenNo: row.specimenNo.trim(),
            verdict: row.verdict,
            category: row.category,
            status: matched ? targetStatus : '挂起',
            beltId: matched ? match.beltId : null,
            fishId: matched ? match.fishId : null,
            attempts: matched ? 0 : 1,
            createdAt: now,
            updatedAt: now
          })
          if (matched && match.fishId) await applyVerdictToFish(match.fishId, targetStatus)
          created += 1
          if (!matched) suspended += 1
        }
      }
    })
    return { batchId, created, updated, suspended }
  }

  /** 复核结论落账到观察员记录的复核状态（只改状态，不顶数量 / 体长段） */
  async function applyVerdictToFish(fishId: string, sheetStatus: LabReviewSheet['status']): Promise<void> {
    const reviewStatus: FishReviewStatus = sheetStatus === '待复检' ? '待复检' : '已复核'
    await db.fishes.update(fishId, { reviewStatus, updatedAt: Date.now() } as never)
  }

  /** 挂起单人工裁定：指到一条观察员计数记录后落账结论 */
  async function resolveReview(id: string, fishId: string): Promise<void> {
    await db.transaction('rw', [db.labReviews, db.fishes], async () => {
      const sheet = await db.labReviews.get(id)
      const fish = await db.fishes.get(fishId)
      if (!sheet || !fish) return
      const targetStatus = verdictToStatus(sheet.verdict)
      await db.labReviews.put({
        ...sheet,
        status: targetStatus,
        beltId: fish.beltId,
        fishId,
        beltNo: belts.value.find((belt) => belt.id === fish.beltId)?.no ?? sheet.beltNo,
        updatedAt: Date.now()
      })
      await applyVerdictToFish(fishId, targetStatus)
    })
  }

  /** 挂起单自动重试：只重试实验室这份对账，不改动观察员任何记录 */
  async function retryReview(id: string): Promise<boolean> {
    const sheet = await db.labReviews.get(id)
    if (!sheet || sheet.status !== '挂起') return false
    const match = reconcile({ beltNo: sheet.beltNo, family: sheet.family })
    if (match.beltId === null || match.fishId === null) {
      await db.labReviews.update(id, { attempts: sheet.attempts + 1, updatedAt: Date.now() } as never)
      return false
    }
    const targetStatus = verdictToStatus(sheet.verdict)
    await db.transaction('rw', [db.labReviews, db.fishes], async () => {
      await db.labReviews.put({
        ...sheet,
        status: targetStatus,
        beltId: match.beltId,
        fishId: match.fishId,
        attempts: sheet.attempts + 1,
        updatedAt: Date.now()
      })
      if (match.fishId) await applyVerdictToFish(match.fishId, targetStatus)
    })
    return true
  }

  /** 实验室删除自己这份复核单：被其锁定状态的观察员记录退回待复核 */
  async function removeReview(id: string): Promise<void> {
    const sheet = await db.labReviews.get(id)
    await db.transaction('rw', [db.labReviews, db.fishes], async () => {
      await db.labReviews.delete(id)
      if (sheet?.fishId) {
        const fish = await db.fishes.get(sheet.fishId)
        if (fish && fish.reviewStatus !== '待复核') {
          await db.fishes.update(sheet.fishId, {
            reviewStatus: '待复核',
            updatedAt: Date.now()
          } as never)
        }
      }
    })
  }

  /** 按状态筛选复核单 */
  function reviewsByStatus(status: LabReviewSheet['status'] | '全部'): LabReviewSheet[] {
    const list = status === '全部' ? labReviews.value : labReviews.value.filter((sheet) => sheet.status === status)
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 挂起中的复核单（等人定） */
  const suspendedReviews = computed<LabReviewSheet[]>(() =>
    labReviews.value
      .filter((sheet) => sheet.status === '挂起')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )

  return {
    corals,
    fishes,
    labReviews,
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
    suspendedReviews,
    start,
    coralsOfBelt,
    fishesOfBelt,
    effectiveSizeClass,
    reviewOfFish,
    includedFishes,
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
    reconcile,
    ingestReviewBatch,
    resolveReview,
    retryReview,
    removeReview,
    reviewsByStatus
  }
})
