import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import Anthropic from '@anthropic-ai/sdk'

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET!
const TRELLO_KEY = process.env.TRELLO_API_KEY!
const TRELLO_TOKEN = process.env.TRELLO_TOKEN!
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID!

// LINE署名検証
function verifySignature(body: string, signature: string): boolean {
  const hash = crypto
    .createHmac('SHA256', LINE_SECRET)
    .update(body)
    .digest('base64')
  return hash === signature
}

// LINE返信
async function replyToLine(replyToken: string, text: string) {
  // LINEメッセージは5000文字制限
  const trimmed = text.length > 5000 ? text.slice(0, 4997) + '...' : text
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text: trimmed }],
    }),
  })
}

// Trelloタスク取得
async function getTrelloTasks(): Promise<string> {
  try {
    const url = `https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/lists?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}&cards=open&card_fields=name,due`
    const resp = await fetch(url)
    if (!resp.ok) return 'Trello取得エラー'
    const lists = await resp.json() as any[]
    const lines: string[] = []
    for (const lst of lists) {
      const cards = lst.cards || []
      if (!cards.length) continue
      lines.push(`■ ${lst.name}`)
      for (const card of cards) {
        const due = card.due ? `（期限: ${card.due.slice(0, 10)}）` : ''
        lines.push(`  - ${card.name}${due}`)
      }
    }
    return lines.join('\n') || 'タスクなし'
  } catch {
    return 'Trello取得エラー'
  }
}

// Claude で返事を生成
async function generateReply(userMessage: string, tasks: string): Promise<string> {
  const client = new Anthropic()
  const today = new Date().toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  })

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `あなたは優秀なAI秘書です。ユーザー（1人会社の社長）のメッセージに対して、秘書として的確に返答してください。

## 今日の日付
${today}

## 現在のTrelloタスク
${tasks}

## ルール
- 簡潔に、LINEで読みやすい長さで返答（300文字以内目安）
- タスクについて聞かれたらTrelloの情報を元に回答
- 「了解」「承知しました」等のリアクションは簡潔に
- スケジュールやタスクの相談にはアドバイスも添えて
- 敬語で丁寧に、でも堅すぎず親しみやすく
- 絵文字は控えめに（使うなら1-2個まで）`,
    messages: [{ role: 'user', content: userMessage }],
  })

  const block = response.content[0]
  return block.type === 'text' ? block.text : '申し訳ありません、返答を生成できませんでした。'
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok' })
  }
  if (req.method !== 'POST') {
    return res.status(405).end()
  }

  // 署名検証
  const signature = req.headers['x-line-signature'] as string
  if (!signature || !LINE_SECRET) {
    return res.status(200).json({ ok: true, message: 'no signature or secret' })
  }
  const body = JSON.stringify(req.body)
  if (!verifySignature(body, signature)) {
    return res.status(200).json({ ok: true, message: 'signature mismatch' })
  }

  const events = req.body?.events || []

  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue

    const userMessage = event.message.text as string
    const replyToken = event.replyToken as string

    try {
      const tasks = await getTrelloTasks()
      const reply = await generateReply(userMessage, tasks)
      await replyToLine(replyToken, reply)
    } catch (e) {
      console.error('Error:', e)
      await replyToLine(replyToken, '申し訳ありません、エラーが発生しました。しばらくしてからお試しください。')
    }
  }

  return res.status(200).json({ ok: true })
}
