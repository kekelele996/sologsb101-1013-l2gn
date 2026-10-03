/**
 * 镜检复核单（实验室那份）：与观察员的鱼类计数分表保存，互不覆盖。
 * - 标本号与复核结论只认这份，观察员侧只读展示
 * - 按「样带编号 + 科名」与观察员计数对账，对不上的挂起等人定
 * - 同一批复核单重送按「批次号 + 标本号」去重，不多出结论
 */
import { SIZE_CLASSES, type ReviewStatus, type SizeClass } from '@/types/fishCount'

/** 复核结论：确认 / 待复检 */
export type ReviewConclusion = '确认' | '待复检'

export const REVIEW_CONCLUSIONS: ReviewConclusion[] = ['确认', '待复检']

/** 对账状态：已对上 / 挂起（对不上，等人定） */
export type ReconStatus = '已对上' | '挂起'

export const RECON_STATUSES: ReconStatus[] = ['已对上', '挂起']

/** 镜检复核单 */
export interface FishReview {
  id: string
  /** 送检批次号：同一批复核单重送时按「批次号 + 标本号」去重 */
  batchId: string
  /** 样带编号（对账键，实验室按编号记，不直接引用样带 id） */
  beltNo: string
  /** 科名（对账键） */
  family: string
  /** 标本号（只认实验室这份） */
  specimenNo: string
  /** 镜检复核改定的体长段（实验室口径，不会被观察员补记顶回） */
  reviewedSizeClass: SizeClass
  /** 复核结论（只认实验室这份） */
  conclusion: ReviewConclusion
  /** 对账状态 */
  reconStatus: ReconStatus
  /** 对上的观察员计数记录 id；挂起时为 null */
  fishId: string | null
  /** 备注 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 复核结论 → 观察员计数记录的复核状态 */
export function conclusionToReviewStatus(conclusion: ReviewConclusion): ReviewStatus {
  return conclusion === '确认' ? '已复核' : '待复检'
}

/** 复核单粘贴行 */
export interface ReviewPasteRow {
  beltNo: string
  family: string
  specimenNo: string
  reviewedSizeClass: SizeClass
  conclusion: ReviewConclusion
  note: string
}

/**
 * 解析复核单批量粘贴文本：每行「样带编号,科名,标本号,复核体长段,结论[,备注]」。
 */
export function parseReviewPaste(text: string): { rows: ReviewPasteRow[]; errors: string[] } {
  const rows: ReviewPasteRow[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；]+/).map((cell) => cell.trim())
    if (cells.length < 5) {
      errors.push(`第 ${index + 1} 行「${line}」至少需要「样带编号,科名,标本号,复核体长段,结论」五列`)
      return
    }
    const reviewedSizeClass = cells[3] as SizeClass
    if (!SIZE_CLASSES.includes(reviewedSizeClass)) {
      errors.push(`第 ${index + 1} 行复核体长段「${cells[3]}」不在 ${SIZE_CLASSES.join(' / ')} 之内`)
      return
    }
    const conclusion = cells[4] as ReviewConclusion
    if (!REVIEW_CONCLUSIONS.includes(conclusion)) {
      errors.push(`第 ${index + 1} 行结论「${cells[4]}」不在 ${REVIEW_CONCLUSIONS.join(' / ')} 之内`)
      return
    }
    rows.push({
      beltNo: cells[0],
      family: cells[1],
      specimenNo: cells[2],
      reviewedSizeClass,
      conclusion,
      note: cells.length >= 6 ? cells[5] : ''
    })
  })
  return { rows, errors }
}
