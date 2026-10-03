/**
 * 实验室镜检复核单（与观察员鱼类计数分账保存）。
 * 鱼类与无脊椎动物计数归观察员（fishes 表）；标本号、复核体长段与复核结论
 * 只以本表（labReviews 表）为准，观察员补记不得顶回实验室的改判。
 */
import type { CountCategory, FishReviewStatus, SizeClass } from '@/types/fishCount'
import { COUNT_CATEGORIES, FISH_REVIEW_STATUSES, SIZE_CLASSES } from '@/types/fishCount'

export type { FishReviewStatus }
export { FISH_REVIEW_STATUSES }

/** 只有「已复核」的计数才参与密度折算与汇总 */
export function isDensityIncluded(status: FishReviewStatus | undefined): boolean {
  return status === '已复核'
}

/** 实验室复核结论 */
export type ReviewVerdict = '符合' | '改判体长段' | '待复检'

export const REVIEW_VERDICTS: ReviewVerdict[] = ['符合', '改判体长段', '待复检']

/**
 * 复核单状态：
 * - 已复核：按样带编号 + 科名对得上观察员记录，结论落账
 * - 待复检：实验室挂出复检，等观察员重新核对数量 / 体长段
 * - 挂起：对账失败（编号 / 科名对不上，或一科多条无法唯一定位），等人定
 */
export type LabReviewStatus = '已复核' | '待复检' | '挂起'

export const LAB_REVIEW_STATUSES: LabReviewStatus[] = ['已复核', '待复检', '挂起']

/** 镜检复核单 */
export interface LabReviewSheet {
  id: string
  /** 送达批次号：同一批复核单重送时按批次内自然键幂等落账，不多出结论 */
  batchId: string
  /** 样带编号（对账键之一，与观察员按样带编号 + 科名对账） */
  beltNo: string
  /** 科名（对账键之二） */
  family: string
  /** 观察员记录的体长段（实验室侧留存，不受观察员补记影响） */
  observerSizeClass: SizeClass
  /** 复核认定体长段；结论与体长段只认实验室这份 */
  reviewedSizeClass: SizeClass
  /** 标本号（只认实验室这份） */
  specimenNo: string
  /** 复核结论 */
  verdict: ReviewVerdict
  /** 复核单状态 */
  status: LabReviewStatus
  /** 类别：鱼类 / 无脊椎动物 */
  category: CountCategory
  /** 对账命中的样带 id；挂起时为空，等人定后回填 */
  beltId: string | null
  /** 对账命中的观察员计数记录 id；挂起时为空 */
  fishId: string | null
  /** 自动对账重试次数（对账失败只重试实验室这份） */
  attempts: number
  createdAt: number
  updatedAt: number
}

/** 批量送达的复核单原始行（批量粘贴 / 重送批次） */
export interface LabReviewInput {
  beltNo: string
  family: string
  observerSizeClass: SizeClass
  reviewedSizeClass: SizeClass
  specimenNo: string
  verdict: ReviewVerdict
  category: CountCategory
}

/** 复核单录入草稿 */
export interface LabReviewDraft {
  beltNo: string
  family: string
  observerSizeClass: SizeClass
  reviewedSizeClass: SizeClass
  specimenNo: string
  verdict: ReviewVerdict
  category: CountCategory
}

export function createEmptyLabReviewDraft(): LabReviewDraft {
  return {
    beltNo: '',
    family: '',
    observerSizeClass: '11-20cm',
    reviewedSizeClass: '11-20cm',
    specimenNo: '',
    verdict: '符合',
    category: '鱼类'
  }
}

/** 结论 → 复核单状态 */
export function verdictToStatus(verdict: ReviewVerdict): LabReviewStatus {
  return verdict === '待复检' ? '待复检' : '已复核'
}

/**
 * 批次内自然键：同一 batchId + 样带编号 + 科名 + 标本号视为同一张单，
 * 重送时只更新原单、重试对账，不产生第二条结论。
 */
export function reviewNaturalKey(input: Pick<LabReviewInput, 'beltNo' | 'family' | 'specimenNo'>): string {
  return `${input.beltNo.trim()}|${input.family.trim()}|${input.specimenNo.trim()}`
}

/**
 * 由批次号与自然键生成稳定主键：纯哈希，重送同一行得到同一个 id。
 * scopeKey 用于消除「不同样带编号相同」（如多个站位都有 T-01）的撞键；
 * 外部送达批次不传，内部播种 / 迁移传样带 id。
 */
export function reviewSheetId(
  batchId: string,
  input: Pick<LabReviewInput, 'beltNo' | 'family' | 'specimenNo'>,
  scopeKey = ''
): string {
  const key = `${batchId}::${scopeKey ? `${scopeKey}::` : ''}${reviewNaturalKey(input)}`
  let hash1 = 0
  let hash2 = 0
  for (let i = 0; i < key.length; i += 1) {
    hash1 = (hash1 * 31 + key.charCodeAt(i)) | 0
    hash2 = (hash2 * 137 + key.charCodeAt(i)) | 0
  }
  return `lab_${(hash1 >>> 0).toString(36)}${(hash2 >>> 0).toString(36)}`
}

/** 生成新的送达批次号 */
export function createBatchId(): string {
  return `B${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 解析批量送达文本：每行
 * 「样带编号,科名,观察体长段,复核体长段,标本号,结论[,类别]」。
 */
export function parseLabReviewPaste(text: string): {
  rows: LabReviewInput[]
  errors: string[]
} {
  const rows: LabReviewInput[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；]+/).map((cell) => cell.trim())
    if (cells.length < 6) {
      errors.push(`第 ${index + 1} 行「${line}」至少需要「样带编号,科名,观察体长段,复核体长段,标本号,结论」六列`)
      return
    }
    if (!SIZE_CLASSES.includes(cells[2] as SizeClass)) {
      errors.push(`第 ${index + 1} 行观察体长段「${cells[2]}」不在 ${SIZE_CLASSES.join(' / ')} 之内`)
      return
    }
    if (!SIZE_CLASSES.includes(cells[3] as SizeClass)) {
      errors.push(`第 ${index + 1} 行复核体长段「${cells[3]}」不在 ${SIZE_CLASSES.join(' / ')} 之内`)
      return
    }
    const verdict = cells[5] as ReviewVerdict
    if (!REVIEW_VERDICTS.includes(verdict)) {
      errors.push(`第 ${index + 1} 行结论「${cells[5]}」不在 ${REVIEW_VERDICTS.join(' / ')} 之内`)
      return
    }
    const category = (cells.length >= 7 ? cells[6] : '鱼类') as CountCategory
    if (!COUNT_CATEGORIES.includes(category)) {
      errors.push(`第 ${index + 1} 行类别「${cells[6]}」不在 ${COUNT_CATEGORIES.join(' / ')} 之内`)
      return
    }
    rows.push({
      beltNo: cells[0],
      family: cells[1],
      observerSizeClass: cells[2] as SizeClass,
      reviewedSizeClass: cells[3] as SizeClass,
      specimenNo: cells[4],
      verdict,
      category
    })
  })
  return { rows, errors }
}
