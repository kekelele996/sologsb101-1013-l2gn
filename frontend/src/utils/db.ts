/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（礁区 → 站位 → 样带 → 珊瑚记录/鱼类计数/镜检复核）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 *
 * 分账说明（v3）：
 * - fishes 为观察员计数台账，记录数量、体长段与复核状态；
 * - labReviews 为实验室镜检复核单，标本号、复核体长段与复核结论只认实验室这份，
 *   观察员补记不顶回实验室改判。
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { FishCount, FishReviewStatus, SizeClass } from '@/types/fishCount'
import type { LabReviewSheet, LabReviewStatus, ReviewVerdict } from '@/types/labReview'
import { reviewSheetId, verdictToStatus } from '@/types/labReview'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbcoralbelt'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbcoralbelt:db-version',
  lastBackupAt: 'gbcoralbelt:last-backup-at',
  lastReefId: 'gbcoralbelt:last-reef-id'
} as const

/** 备份文件结构，供 utils/export.ts 与覆盖度汇总页使用 */
export interface BackupPayload {
  app: 'gbcoralbelt'
  dbVersion: number
  exportedAt: string
  reefs: Reef[]
  sites: Site[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
  labReviews: LabReviewSheet[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  belts!: Table<Belt, string>
  corals!: Table<CoralRecord, string>
  fishes!: Table<FishCount, string>
  labReviews!: Table<LabReviewSheet, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      reefs: 'id, name, protectStatus',
      sites: 'id, reefId, no',
      belts: 'id, siteId, no, surveyDate',
      corals: 'id, beltId, genus, form',
      fishes: 'id, beltId, family, sizeClass'
    })

    // v2：补齐筛选与统计需要的索引（位置/面积、经纬度/水深、样带长度与朝向、白化等级、类别）
    this.version(2).stores({
      reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
      sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
      belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
      corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
      fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
    })

    // v3：观察员计数与实验室镜检复核分账
    this.version(DB_VERSION)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, reviewStatus, updatedAt',
        labReviews:
          'id, batchId, beltNo, family, specimenNo, verdict, status, category, beltId, fishId, attempts, updatedAt'
      })
      .upgrade(async (tx) => {
        // v2 迁移：历史数据补齐时间戳与必填字段，避免列表排序与筛选拿到 undefined
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['reefs', () => ({ manager: '', areaKm2: 0 })],
          ['sites', () => ({ lat: 0, lng: 0, depthM: 5, substrate: '珊瑚礁石' })],
          ['belts', () => ({ lengthM: 50, orientation: '北', observer: '' })],
          ['corals', () => ({ coverCm: 0, bleachLevel: '无', remark: '' })],
          ['fishes', () => ({ count: 0, sizeClass: '11-20cm', category: '鱼类' })]
        ]
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, factory())
            })
        }

        // v3 迁移（一）：旧数据没记复核状态，按现有记录补一版 —— 一律视为已复核，
        // 折算密度口径与升级前保持一致。
        await tx
          .table('fishes')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.reviewStatus !== 'string') row.reviewStatus = '已复核'
          })

        // v3 迁移（二）：为每条现有计数补一张实验室复核单（标本号留空、结论「符合」），
        // 让实验室这份分账在升级后有历史落账；同一记录重复升级不重复补单。
        const fishes = await tx.table<FishCount, string>('fishes').toArray()
        const belts = await tx.table<Belt, string>('belts').toArray()
        const beltById = new Map(belts.map((belt) => [belt.id, belt]))
        const existing = await tx.table<LabReviewSheet, string>('labReviews').toArray()
        const existingFishIds = new Set(existing.map((sheet) => sheet.fishId))
        const now = Date.now()
        const sheets: LabReviewSheet[] = []
        fishes.forEach((fish, index) => {
          if (fish.reviewStatus !== '已复核' || existingFishIds.has(fish.id)) return
          const belt = beltById.get(fish.beltId)
          const batchId = 'MIGRATION-V3'
          const input = { beltNo: belt?.no ?? '', family: fish.family, specimenNo: '' }
          sheets.push({
            id: reviewSheetId(batchId, input, fish.id),
            batchId,
            beltNo: belt?.no ?? '',
            family: fish.family,
            observerSizeClass: fish.sizeClass,
            reviewedSizeClass: fish.sizeClass,
            specimenNo: '',
            verdict: '符合',
            status: '已复核',
            category: fish.category,
            beltId: fish.beltId,
            fishId: fish.id,
            attempts: 0,
            createdAt: (typeof fish.createdAt === 'number' ? fish.createdAt : now) + index,
            updatedAt: now
          })
        })
        if (sheets.length > 0) await tx.table<LabReviewSheet, string>('labReviews').bulkPut(sheets)
      })
  }
}

export const db = new CoralBeltDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCoral {
  id: string
  beltId: string
  genus: string
  form: CoralRecord['form']
  coverCm: number
  bleachLevel: CoralRecord['bleachLevel']
  remark: string
}

interface SeedFish {
  id: string
  beltId: string
  family: string
  count: number
  sizeClass: FishCount['sizeClass']
  category: FishCount['category']
  /** 演示复核状态；待复核的记录不补复核单 */
  reviewStatus: FishReviewStatus
}

/** 演示用镜检复核单（挂起单 fishId 留空） */
interface SeedReview {
  beltId: string | null
  fishId: string | null
  beltNo: string
  family: string
  observerSizeClass: SizeClass
  reviewedSizeClass: SizeClass
  specimenNo: string
  verdict: ReviewVerdict
  status: LabReviewStatus
  category: FishCount['category']
  attempts: number
}

interface SeedBelt {
  id: string
  siteId: string
  no: string
  lengthM: number
  orientation: Belt['orientation']
  surveyDate: string
  observer: string
  corals: SeedCoral[]
  fishes: SeedFish[]
  reviews: SeedReview[]
}

/**
 * 播种演示数据：3 个礁区 → 4 个站位 → 5 条样带 → 14 条珊瑚记录 + 15 条鱼类计数 + 14 张复核单，
 * 覆盖无 / 轻 / 中 / 重 / 死亡 全部白化等级与待复核 / 待复检 / 已复核 / 挂起 全部对账状态，
 * 保证每个页面打开都有内容、层级路由也能命中真实 id。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)

  const reefs: Array<Omit<Reef, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'reef_ql01',
      name: '清澜湾珊瑚礁区',
      location: '海南文昌清澜湾东侧 3.5 km 海域',
      areaKm2: 18.6,
      protectStatus: '核心区',
      manager: '清澜湾海洋保护站'
    },
    {
      id: 'reef_yr02',
      name: '永兴岛西侧礁盘',
      location: '西沙永兴岛西侧礁盘外缘',
      areaKm2: 42.3,
      protectStatus: '缓冲区',
      manager: '西沙海洋环境监测中心'
    },
    {
      id: 'reef_dz03',
      name: '大洲岛南岸礁区',
      location: '万宁大洲岛南岸潮下带',
      areaKm2: 6.4,
      protectStatus: '实验区',
      manager: '大洲岛国家级自然保护区管理处'
    }
  ]

  const sites: Array<Omit<Site, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'site_ql_01',
      reefId: 'reef_ql01',
      no: 'S-01',
      lat: 19.5621,
      lng: 110.7924,
      depthM: 4.2,
      substrate: '珊瑚礁石'
    },
    {
      id: 'site_ql_02',
      reefId: 'reef_ql01',
      no: 'S-02',
      lat: 19.5487,
      lng: 110.8103,
      depthM: 8.6,
      substrate: '礁砂'
    },
    {
      id: 'site_yr_01',
      reefId: 'reef_yr02',
      no: 'S-01',
      lat: 16.8342,
      lng: 112.3286,
      depthM: 12.4,
      substrate: '砾石'
    },
    {
      id: 'site_dz_01',
      reefId: 'reef_dz03',
      no: 'S-01',
      lat: 18.6712,
      lng: 110.4913,
      depthM: 6.8,
      substrate: '岩礁'
    }
  ]

  const reviewed = (
    belt: SeedBelt,
    id: string,
    family: string,
    count: number,
    sizeClass: FishCount['sizeClass'],
    category: FishCount['category'],
    extra: Partial<SeedReview> = {}
  ): { fish: SeedFish; review: SeedReview } => ({
    fish: { id, beltId: belt.id, family, count, sizeClass, category, reviewStatus: '已复核' },
    review: {
      beltId: belt.id,
      fishId: id,
      beltNo: belt.no,
      family,
      observerSizeClass: sizeClass,
      reviewedSizeClass: sizeClass,
      specimenNo: `SP-${id.replace('fsh_', '').toUpperCase()}`,
      verdict: '符合',
      status: '已复核',
      category,
      attempts: 0,
      ...extra
    }
  })

  const belts: SeedBelt[] = [
    {
      id: 'belt_ql01_a',
      siteId: 'site_ql_01',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: today,
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01a_1', beltId: 'belt_ql01_a', genus: '鹿角珊瑚属', form: '枝状', coverCm: 860, bleachLevel: '无', remark: '长势良好' },
        { id: 'cor_ql01a_2', beltId: 'belt_ql01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 540, bleachLevel: '轻', remark: '局部褪色' },
        { id: 'cor_ql01a_3', beltId: 'belt_ql01_a', genus: '滨珊瑚属', form: '块状', coverCm: 1120, bleachLevel: '无', remark: '' },
        { id: 'cor_ql01a_4', beltId: 'belt_ql01_a', genus: '软珊瑚属', form: '软珊瑚', coverCm: 380, bleachLevel: '轻', remark: '' }
      ],
      fishes: [],
      reviews: []
    },
    {
      id: 'belt_ql01_b',
      siteId: 'site_ql_01',
      no: 'T-02',
      lengthM: 50,
      orientation: '东',
      surveyDate: today,
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01b_1', beltId: 'belt_ql01_b', genus: '蔷薇珊瑚属', form: '叶状', coverCm: 720, bleachLevel: '中', remark: '边缘白化明显' },
        { id: 'cor_ql01b_2', beltId: 'belt_ql01_b', genus: '蜂巢珊瑚属', form: '块状', coverCm: 980, bleachLevel: '轻', remark: '' },
        { id: 'cor_ql01b_3', beltId: 'belt_ql01_b', genus: '鹿角珊瑚属', form: '枝状', coverCm: 430, bleachLevel: '重', remark: '大面积白化，部分死亡' }
      ],
      fishes: [],
      reviews: []
    },
    {
      id: 'belt_ql02_a',
      siteId: 'site_ql_02',
      no: 'T-01',
      lengthM: 30,
      orientation: '南',
      surveyDate: today,
      observer: '周渝',
      corals: [
        { id: 'cor_ql02a_1', beltId: 'belt_ql02_a', genus: '滨珊瑚属', form: '块状', coverCm: 1240, bleachLevel: '无', remark: '' },
        { id: 'cor_ql02a_2', beltId: 'belt_ql02_a', genus: '陀螺珊瑚属', form: '块状', coverCm: 260, bleachLevel: '死亡', remark: '仅存骨骼，附着藻类' }
      ],
      fishes: [],
      reviews: []
    },
    {
      id: 'belt_yr01_a',
      siteId: 'site_yr_01',
      no: 'T-01',
      lengthM: 100,
      orientation: '西',
      surveyDate: today,
      observer: '陈立群',
      corals: [
        { id: 'cor_yr01a_1', beltId: 'belt_yr01_a', genus: '星珊瑚属', form: '块状', coverCm: 1580, bleachLevel: '轻', remark: '' },
        { id: 'cor_yr01a_2', beltId: 'belt_yr01_a', genus: '柳珊瑚属', form: '软珊瑚', coverCm: 640, bleachLevel: '中', remark: '水流较强区域' },
        { id: 'cor_yr01a_3', beltId: 'belt_yr01_a', genus: '石芝珊瑚属', form: '叶状', coverCm: 480, bleachLevel: '无', remark: '' }
      ],
      fishes: [],
      reviews: []
    },
    {
      id: 'belt_dz01_a',
      siteId: 'site_dz_01',
      no: 'T-01',
      lengthM: 25,
      orientation: '东',
      surveyDate: today,
      observer: '陈立群',
      corals: [
        { id: 'cor_dz01a_1', beltId: 'belt_dz01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 520, bleachLevel: '重', remark: '受台风扰动后白化' },
        { id: 'cor_dz01a_2', beltId: 'belt_dz01_a', genus: '蜂巢珊瑚属', form: '块状', coverCm: 310, bleachLevel: '中', remark: '' }
      ],
      fishes: [],
      reviews: []
    }
  ]

  // 观察员计数（fishes 这份）与实验室复核单（labReviews 这份）分开装配
  const beltA = belts[0]
  ;[
    reviewed(beltA, 'fsh_ql01a_1', '雀鲷科', 46, '0-10cm', '鱼类'),
    reviewed(beltA, 'fsh_ql01a_2', '蝴蝶鱼科', 18, '11-20cm', '鱼类'),
    reviewed(beltA, 'fsh_ql01a_3', '鹦嘴鱼科', 7, '21-30cm', '鱼类'),
    reviewed(beltA, 'fsh_ql01a_4', '海胆科', 12, '0-10cm', '无脊椎动物')
  ].forEach(({ fish, review }) => {
    beltA.fishes.push(fish)
    beltA.reviews.push(review)
  })

  const beltB = belts[1]
  // 隆头鱼科：实验室改判体长段 11-20 → 21-30（观察员那份保留原值，体长段只认复核单）
  ;[
    reviewed(beltB, 'fsh_ql01b_1', '隆头鱼科', 22, '11-20cm', '鱼类', {
      reviewedSizeClass: '21-30cm',
      verdict: '改判体长段',
      specimenNo: 'SP-QL01B-01'
    }),
    reviewed(beltB, 'fsh_ql01b_2', '刺尾鱼科', 15, '21-30cm', '鱼类'),
    reviewed(beltB, 'fsh_ql01b_3', '砗磲科', 3, '>30cm', '无脊椎动物')
  ].forEach(({ fish, review }) => {
    beltB.fishes.push(fish)
    beltB.reviews.push(review)
  })
  // 观察员补记一条，实验室尚未出单 → 待复核，密度先不进汇总
  beltB.fishes.push({
    id: 'fsh_ql01b_4',
    beltId: beltB.id,
    family: '石鲈科',
    count: 9,
    sizeClass: '11-20cm',
    category: '鱼类',
    reviewStatus: '待复核'
  })

  const beltC = belts[2]
  // 石斑鱼科：实验室挂待复检（标本号、结论只认实验室）
  beltC.fishes.push({
    id: 'fsh_ql02a_1',
    beltId: beltC.id,
    family: '石斑鱼科',
    count: 4,
    sizeClass: '>30cm',
    category: '鱼类',
    reviewStatus: '待复检'
  })
  beltC.reviews.push({
    beltId: beltC.id,
    fishId: 'fsh_ql02a_1',
    beltNo: beltC.no,
    family: '石斑鱼科',
    observerSizeClass: '>30cm',
    reviewedSizeClass: '>30cm',
    specimenNo: 'SP-QL02A-01',
    verdict: '待复检',
    status: '待复检',
    category: '鱼类',
    attempts: 1
  })
  ;[reviewed(beltC, 'fsh_ql02a_2', '海参科', 6, '21-30cm', '无脊椎动物')].forEach(({ fish, review }) => {
    beltC.fishes.push(fish)
    beltC.reviews.push(review)
  })

  const beltY = belts[3]
  ;[
    reviewed(beltY, 'fsh_yr01a_1', '笛鲷科', 28, '21-30cm', '鱼类'),
    reviewed(beltY, 'fsh_yr01a_2', '篮子鱼科', 11, '11-20cm', '鱼类')
  ].forEach(({ fish, review }) => {
    beltY.fishes.push(fish)
    beltY.reviews.push(review)
  })
  // 观察员补记，待复核
  beltY.fishes.push({
    id: 'fsh_yr01a_3',
    beltId: beltY.id,
    family: '法螺科',
    count: 2,
    sizeClass: '>30cm',
    category: '无脊椎动物',
    reviewStatus: '待复核'
  })

  const beltD = belts[4]
  ;[
    reviewed(beltD, 'fsh_dz01a_1', '雀鲷科', 34, '0-10cm', '鱼类'),
    reviewed(beltD, 'fsh_dz01a_2', '海星科', 5, '11-20cm', '无脊椎动物')
  ].forEach(({ fish, review }) => {
    beltD.fishes.push(fish)
    beltD.reviews.push(review)
  })
  // 实验室送达但样带编号 + 科名对不上观察员台账 → 挂起等人定（观察员那份不动）
  beltD.reviews.push({
    beltId: null,
    fishId: null,
    beltNo: 'T-09',
    family: '鳞鲀科',
    observerSizeClass: '11-20cm',
    reviewedSizeClass: '11-20cm',
    specimenNo: 'SP-DZ01-SUS',
    verdict: '符合',
    status: '挂起',
    category: '鱼类',
    attempts: 2
  })

  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.labReviews],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset
      })

      await db.reefs.bulkPut(reefs.map((reef, index) => ({ ...reef, ...stamp(index) })))
      await db.sites.bulkPut(sites.map((site, index) => ({ ...site, ...stamp(100 + index) })))
      await db.belts.bulkPut(
        belts.map((belt, index) => {
          const { corals, fishes, reviews, ...rest } = belt
          void corals
          void fishes
          void reviews
          return { ...rest, ...stamp(200 + index) }
        })
      )
      await db.corals.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.corals.map((coral, coralIndex) => ({ ...coral, ...stamp(300 + beltIndex * 100 + coralIndex) }))
        )
      )
      await db.fishes.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.fishes.map((fish, fishIndex) => ({ ...fish, ...stamp(400 + beltIndex * 100 + fishIndex) }))
        )
      )

      // 复核单统一归入一个送达批次，自然键稳定 → 重复播种不会多出结论
      const batchId = 'SEED-V3'
      const reviewRows: LabReviewSheet[] = belts.flatMap((belt, beltIndex) =>
        belt.reviews.map((review, reviewIndex) => {
          const stampOffset = 500 + beltIndex * 100 + reviewIndex
          const input = { beltNo: review.beltNo, family: review.family, specimenNo: review.specimenNo }
          return {
            id: reviewSheetId(batchId, input, review.beltId ?? undefined),
            batchId,
            ...review,
            createdAt: now + stampOffset,
            updatedAt: now + stampOffset
          }
        })
      )
      await db.labReviews.bulkPut(reviewRows)
    }
  )
}

/** 打开数据库并幂等播种：仅当礁区表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.reefs.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.labReviews],
    async () => {
      await Promise.all([
        db.reefs.clear(),
        db.sites.clear(),
        db.belts.clear(),
        db.corals.clear(),
        db.fishes.clear(),
        db.labReviews.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与覆盖度页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [reefs, sites, belts, corals, fishes, labReviews] = await Promise.all([
    db.reefs.count(),
    db.sites.count(),
    db.belts.count(),
    db.corals.count(),
    db.fishes.count(),
    db.labReviews.count()
  ])
  return { reefs, sites, belts, corals, fishes, labReviews }
}

/** 写入结构版本号到 localStorage，便于覆盖度页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastReefId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastReefId)
  } catch {
    return null
  }
}

export function writeLastReefId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastReefId)
    else localStorage.setItem(LS_KEYS.lastReefId, id)
  } catch {
    // 忽略
  }
}
