import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'

const BUCKET = 'vb-e2e-email-inbox-dev'
const REGION = 'eu-west-2'

const s3 = new S3Client({ region: REGION })

interface ParsedEmail {
  messageId: string
  from: string
  to: string[]
  subject: string
  date: string
  bodyText: string
  bodyHtml: string
}

export async function waitForEmail(
  recipientEmail: string,
  opts: { subjectContains?: string; timeoutMs?: number; pollMs?: number } = {}
): Promise<ParsedEmail> {
  const { subjectContains, timeoutMs = 60_000, pollMs = 5_000 } = opts
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const emails = await listParsedEmails()

    const match = emails.find((e) => {
      const toMatch = Array.isArray(e.to)
        ? e.to.some((addr: string) => addr.includes(recipientEmail))
        : String(e.to).includes(recipientEmail)
      if (!toMatch) return false
      if (subjectContains && !e.subject?.toLowerCase().includes(subjectContains.toLowerCase()))
        return false
      return true
    })

    if (match) return match

    await new Promise((r) => setTimeout(r, pollMs))
  }

  throw new Error(`No email found for ${recipientEmail} within ${timeoutMs}ms`)
}

async function listParsedEmails(): Promise<ParsedEmail[]> {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'parsed/' }))

  if (!list.Contents?.length) return []

  const recent = list.Contents.filter((obj) => {
    if (!obj.LastModified) return false
    return Date.now() - obj.LastModified.getTime() < 5 * 60 * 1000
  }).sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))

  const emails: ParsedEmail[] = []
  for (const obj of recent.slice(0, 20)) {
    const get = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }))
    const body = await get.Body?.transformToString()
    if (body) emails.push(JSON.parse(body) as ParsedEmail)
  }

  return emails
}
