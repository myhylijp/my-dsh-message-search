/**
 * 消息检索 — Host half.
 *
 * 直接扫描 `<dshHome>/sessions/**\/session.*.jsonl.zstd`：按 zstd 帧切分解码、逐行解析
 * JSONL 事件，取出 user/assistant 的文本消息，做大小写不敏感的子串匹配。
 *
 * 为什么不走 sessionQuery 的内容检索：那套索引会迁移历史会话日志（v0 → v4），
 * 遇到"step/end 有未闭合工具调用"的旧日志会整体失败（SessionQueryError），
 * 一条坏日志就让整次检索报错。这里改成"逐会话解析，坏的跳过并计数"，检索永远能出结果。
 *
 * Client 半边通过本插件私有的 `/api/message-search` 路由取数据。
 *
 * @param {object} ctx - 本行所在的 Cordis 上下文。
 * @param {object} [config] - 本行配置；`maxHits` 限制返回条数。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'

export const name = 'message-search'

/** Client 页面读取的私有路由。 */
const HTTP_PATH = '/api/message-search'
/** Host 构建标记。 */
const HOST_REVISION = '2026-11-18.6'
/** 一次检索最多返回多少条命中。 */
const MAX_BLOB_BYTES = 12 * 1024 * 1024
const DEFAULT_MAX_HITS = 200
/** 片段前后各取多少字符。 */
const SNIPPET_PAD = 80
/** zstd 帧魔数。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 取一个可选服务。
 * @param {object} ctx - 插件上下文。
 * @param {string} key - 服务名。
 * @returns {object | undefined} 服务实例。
 */
function readService(ctx, key) {
  try {
    return ctx.get?.(key)
  } catch {
    return undefined
  }
}

/**
 * 描述一个异常。
 * @param {unknown} error - 任意异常。
 * @returns {string} 可读文本。
 */
function describe(error) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}

export function apply(ctx, config) {
  try {
    start(ctx, config)
  } catch (error) {
    console.error(`message-search: 激活失败：${describe(error)}\n${error instanceof Error ? error.stack : ''}`)
    throw error
  }
}

/**
 * 注册路由并准备检索。
 * @param {object} ctx - 插件上下文。
 * @param {object} [config] - 本行配置。
 */
function start(ctx, config) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  const sessionsRoot = path.join(home, 'sessions')
  const attachmentsRoot = path.join(home, 'attachments', 'v1')
  const workspaceFile = path.join(home, 'storages', 'workspace.json')
  const maxHits = Number.isFinite(Number(config?.maxHits)) && Number(config?.maxHits) > 0
    ? Math.min(Math.floor(Number(config.maxHits)), 1000)
    : DEFAULT_MAX_HITS

  /** @type {Map<string, {mtimeMs: number, size: number, title: string, messages: Array<object>}>} */
  const cache = new Map()

  /** 解码一个多帧 zstd 文件（DSH 以追加帧的方式写日志）。 */
  const decodeFrames = (buffer) => {
    const parts = []
    let offset = 0
    while (offset < buffer.length) {
      const next = buffer.indexOf(ZSTD_MAGIC, offset + 4)
      const end = next < 0 ? buffer.length : next
      try {
        parts.push(zlib.zstdDecompressSync(buffer.subarray(offset, end)).toString('utf8'))
      } catch {
        // 单帧损坏就跳过，别让整个会话不可读
      }
      offset = end
    }
    return parts.join('')
  }

  /** 取一条 content 里的纯文本（忽略 reasoning / tool-call）。 */
  const textOf = (content) => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n')
  }

  /** 解析一个会话日志文件 → 标题 + 消息列表。 */
  const parseSession = (file) => {
    const stat = fs.statSync(file)
    const cached = cache.get(file)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached
    const text = decodeFrames(fs.readFileSync(file))
    const messages = []
    const attachments = []
    const writes = []
    const mentions = []
    let title = ''
    let turn = 0
    for (const line of text.split('\n')) {
      if (line === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'session/title' && typeof event.data?.title === 'string') {
        title = event.data.title
        continue
      }
      if (event.type === 'turn/start') {
        turn += 1
        continue
      }
      // 附件（图片 / 文件）出现在三类事件里：用户上传、待发输入、工具产出
      const collectAttachments = (content, origin, meta, source) => {
        if (!Array.isArray(content)) return
        for (const part of content) {
          const ref = part?.attachment
          if (ref === undefined || (part.type !== 'image' && part.type !== 'file')) continue
          attachments.push({
            kind: part.type,
            id: String(ref.attachmentId ?? ''),
            name: String(ref.name ?? ''),
            mediaType: String(ref.mediaType ?? ''),
            bytes: Number(ref.bytes ?? 0),
            width: Number(ref.width ?? 0),
            height: Number(ref.height ?? 0),
            origin,
            source,
            turn: meta.turn,
            seq: meta.seq,
            time: meta.time,
          })
        }
      }
      if (event.type === 'agent/inbox/spliced') {
        for (const entry of Array.isArray(event.data?.inserted) ? event.data.inserted : []) {
          collectAttachments(entry?.content, 'user', { turn, seq: Number(event.seq ?? 0), time: Number(event.time ?? 0) }, 'inbox')
        }
        continue
      }
      if (event.type === 'tool/result') {
        collectAttachments(event.data?.message?.content, 'agent', { turn, seq: Number(event.seq ?? 0), time: Number(event.time ?? 0) }, 'tool')
        continue
      }
      // Agent 写出的文件：write / edit 工具的 path 参数（这两个工具是落盘的）
      if (event.type === 'tool/call') {
        const toolName = String(event.data?.name ?? '')
        if (toolName === 'write' || toolName === 'edit') {
          let args = {}
          try { args = JSON.parse(String(event.data?.arguments ?? '{}')) } catch { args = {} }
          const target = typeof args?.file_path === 'string'
            ? args.file_path
            : (typeof args?.path === 'string' ? args.path : '')
          if (target !== '') {
            writes.push({ path: target, turn, seq: Number(event.seq ?? 0), time: Number(event.time ?? 0) })
          }
        }
        continue
      }
      if (event.type === 'user/message') {
        collectAttachments(event.data?.content, 'user', { turn, seq: Number(event.seq ?? 0), time: Number(event.time ?? 0) }, 'message')
        const content = textOf(event.data?.content)
        // "@C:\path\file.docx" 只是文本引用，不进附件库；照样能在"附件"里查到
        for (const match of content.matchAll(/@([A-Za-z]:[\\/][^\n@]*)/g)) {
          // 不能按空格切：编辑器插入的 chip 后面经常紧跟正文
          // （"@C:\\…\\报告.docx总结一下内容"），只能从长到短试前缀，能 stat 到文件的就是路径。
          const raw = match[1].trim()
          const limit = Math.min(raw.length, 400)
          for (let length = limit; length >= 4; length -= 1) {
            const candidate = raw.slice(0, length).trim().replace(/[，。；、）)】》"'`]+$/, '')
            if (candidate.length < 4) continue
            try {
              if (!fs.statSync(candidate).isFile()) continue
            } catch {
              continue
            }
            mentions.push({ path: candidate, turn, seq: Number(event.seq ?? 0), time: Number(event.time ?? 0) })
            break
          }
        }
        if (content.trim() !== '') {
          messages.push({ role: 'user', text: content, time: Number(event.time ?? 0), seq: Number(event.seq ?? 0), turn })
        }
        continue
      }
      if (event.type === 'assistant/message') {
        const content = textOf(event.data?.message?.content)
        if (content.trim() !== '') {
          const ownTurn = Number.isFinite(Number(event.data?.turn)) && Number(event.data.turn) > 0 ? Number(event.data.turn) : turn
          messages.push({ role: 'assistant', text: content, time: Number(event.time ?? 0), seq: Number(event.seq ?? 0), turn: ownTurn })
        }
      }
    }
    if (title === '' && messages.length > 0) title = messages[0].text.slice(0, 40)
    const parsed = { mtimeMs: stat.mtimeMs, size: stat.size, title, messages, attachments, writes, mentions }
    cache.set(file, parsed)
    return parsed
  }

  /** 列出磁盘上的会话：sessionId → 日志文件。 */
  const listSessions = () => {
    const out = []
    let dirs = []
    try {
      dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
    } catch {
      return out
    }
    for (const group of dirs) {
      const groupDir = path.join(sessionsRoot, group.name)
      let children = []
      try {
        children = fs.readdirSync(groupDir, { withFileTypes: true }).filter(entry => entry.isDirectory())
      } catch {
        continue
      }
      for (const child of children) {
        const sessionDir = path.join(groupDir, child.name)
        let files = []
        try {
          files = fs.readdirSync(sessionDir).filter(name => name.startsWith('session') && name.endsWith('.jsonl.zstd'))
        } catch {
          continue
        }
        if (files.length === 0) continue
        files.sort()
        out.push({
          sessionId: child.name,
          workspaceDir: group.name,
          file: path.join(sessionDir, files[files.length - 1]),
        })
      }
    }
    return out
  }

  /** 工作区清单：sessionId → { id, title }。 */
  const workspaceIndex = () => {
    const bySession = new Map()
    const workspaces = []
    try {
      const parsed = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'))
      const table = parsed?.tables?.workspaces ?? {}
      for (const [id, entry] of Object.entries(table)) {
        workspaces.push({ id, title: String(entry?.title ?? ''), sessionIds: Array.isArray(entry?.sessionIds) ? entry.sessionIds : [] })
        for (const sessionId of Array.isArray(entry?.sessionIds) ? entry.sessionIds : []) {
          bySession.set(sessionId, { id, title: String(entry?.title ?? '') })
        }
      }
    } catch {
      // 没有工作区文件就全部按未分组处理
    }
    return { bySession, workspaces }
  }

  /** 语料概览：给页面显示"共 N 个会话"。 */
  const status = () => {
    const sessions = listSessions()
    const { workspaces } = workspaceIndex()
    return {
      revision: HOST_REVISION,
      sessions: sessions.length,
      workspaces: workspaces.map(item => ({ id: item.id, title: item.title, count: item.sessionIds.length, sessionIds: item.sessionIds })),
    }
  }

  /** 去掉 Markdown 记号，片段按散文读起来更干净。 */
  const plainText = (text) => text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\|/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')

  /** 截取匹配位置附近的片段。 */
  const snippetOf = (text, index, length) => {
    const from = Math.max(0, index - SNIPPET_PAD)
    const to = Math.min(text.length, index + length + SNIPPET_PAD)
    const prefix = from > 0 ? '…' : ''
    const suffix = to < text.length ? '…' : ''
    return `${prefix}${plainText(text.slice(from, to)).trim()}${suffix}`
  }

  /** 检索。scope: current | workspace | all。 */
  const search = (payload) => {
    const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
    const scope = payload?.scope === 'workspace' ? 'workspace' : payload?.scope === 'current' ? 'current' : 'all'
    const started = Date.now()
    if (query === '') throw new Error('请输入检索关键词')
    const needle = query.toLowerCase()
    const { bySession } = workspaceIndex()
    const all = listSessions()

    let scopeSessions = all
    if (scope === 'current') {
      const wanted = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      scopeSessions = all.filter(item => item.sessionId === wanted)
    } else if (scope === 'workspace') {
      const wantedWorkspace = typeof payload?.workspaceId === 'string' ? payload.workspaceId : ''
      const ids = new Set()
      for (const [sessionId, owner] of bySession) {
        if (owner.id === wantedWorkspace) ids.add(sessionId)
      }
      scopeSessions = all.filter(item => ids.has(item.sessionId))
    }

    const hits = []
    const skipped = []
    let scannedMessages = 0
    for (const item of scopeSessions) {
      let parsed
      try {
        parsed = parseSession(item.file)
      } catch (error) {
        skipped.push({ sessionId: item.sessionId, reason: describe(error) })
        continue
      }
      const owner = bySession.get(item.sessionId)
      const title = parsed.title !== '' ? parsed.title : item.sessionId
      for (const message of parsed.messages) {
        scannedMessages += 1
        const lower = message.text.toLowerCase()
        let index = lower.indexOf(needle)
        let count = 0
        let firstIndex = -1
        while (index !== -1 && count < 50) {
          if (firstIndex < 0) firstIndex = index
          count += 1
          index = lower.indexOf(needle, index + needle.length)
        }
        if (count === 0) continue
        hits.push({
          sessionId: item.sessionId,
          title,
          workspaceId: owner?.id ?? '',
          workspaceTitle: owner?.title ?? '',
          role: message.role,
          turn: message.turn ?? 0,
          time: message.time,
          seq: message.seq,
          count,
          snippet: snippetOf(message.text, firstIndex, query.length),
          // 从关键词开始截一段连续文本，供前端定位（片段开头是前置上下文，会定位到上一行）
          match: message.text.slice(firstIndex, firstIndex + 40),
        })
        if (hits.length >= maxHits) break
      }
      if (hits.length >= maxHits) break
    }

    hits.sort((a, b) => b.time - a.time)
    return {
      query,
      scope,
      hits,
      truncated: hits.length >= maxHits,
      scannedSessions: scopeSessions.length,
      scannedMessages,
      skipped,
      elapsedMs: Date.now() - started,
      maxHits,
    }
  }

  /** sha256 去掉前缀。 */
  const shaOf = (id) => String(id ?? '').replace(/^sha256:/i, '')

  /**
   * 附件在磁盘上的路径。
   * 图片归一化后存在 objects/，上传文件原样存在 file-objects/。
   * @param {{kind: string, id: string}} item - 附件条目。
   * @returns {string|null} 绝对路径；id 非法时为 null。
   */
  const attachmentPathOf = (item) => {
    const sha = shaOf(item.id)
    if (!/^[0-9a-f]{64}$/i.test(sha)) return null
    const bucket = item.kind === 'image' ? 'objects' : 'file-objects'
    return path.join(attachmentsRoot, bucket, sha.slice(0, 2), sha)
  }

  /** 会话 + 作用域过滤，附件检索与文本检索共用。 */
  const scopeItems = (payload) => {
    const scope = payload?.scope === 'workspace' ? 'workspace' : payload?.scope === 'current' ? 'current' : 'all'
    const { bySession } = workspaceIndex()
    const all = listSessions()
    if (scope === 'current') {
      const wanted = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      return { scope, bySession, items: all.filter(item => item.sessionId === wanted), sessionId: wanted }
    }
    if (scope === 'workspace') {
      const wantedWorkspace = typeof payload?.workspaceId === 'string' ? payload.workspaceId : ''
      const ids = new Set()
      for (const [sessionId, owner] of bySession) if (owner.id === wantedWorkspace) ids.add(sessionId)
      return { scope, bySession, items: all.filter(item => ids.has(item.sessionId)), workspaceId: wantedWorkspace }
    }
    return { scope, bySession, items: all }
  }

  /**
   * 附件检索：按文件名匹配（空关键词 = 全部），区分用户上传与 Agent 生成。
   * @param {object} payload - { query, scope, sessionId, workspaceId, kind }。
   * @returns {object} 结果。
   */
  const listAttachments = (payload) => {
    const started = Date.now()
    const kind = payload?.kind === 'image' ? 'image' : 'file'
    const query = typeof payload?.query === 'string' ? payload.query.trim().toLowerCase() : ''
    const { scope, bySession, items: scopeSessions } = scopeItems(payload)
    const items = []
    const skipped = []
    let scanned = 0
    for (const session of scopeSessions) {
      let parsed
      try {
        parsed = parseSession(session.file)
      } catch (error) {
        skipped.push({ sessionId: session.sessionId, reason: describe(error) })
        continue
      }
      const owner = bySession.get(session.sessionId)
      const title = parsed.title !== '' ? parsed.title : session.sessionId
      // 同一张图会同时出现在 agent/inbox/spliced、user/message、tool/result 里，
      // 按 (sessionId, attachmentId) 去重，保留第一次出现的位置。
      // 同一条附件会在 inbox / user message / tool result 里重复出现，
      // 用"最可信的事件"决定它属于哪一轮：user/message > tool/result > inbox。
      const priorityOf = (source) => (source === 'message' ? 3 : source === 'tool' ? 2 : 1)
      const seen = new Map()
      if (kind === 'file') {
        // 用户在消息里 @ 引用的本地文件（不在附件库，只有路径）
        for (const mention of parsed.mentions ?? []) {
          const name = path.basename(mention.path)
          if (query !== '' && !name.toLowerCase().includes(query)) continue
          const key = session.sessionId + '|mention|' + mention.path
          if (seen.has(key)) continue
          seen.set(key, { source: 'mention', seq: mention.seq, turn: mention.turn })
          scanned += 1
          let exists = false
          let bytes = 0
          try {
            const stat = fs.statSync(mention.path)
            exists = stat.isFile()
            bytes = exists ? stat.size : 0
          } catch { exists = false }
          items.push({
            kind: 'file',
            id: '',
            name,
            mediaType: '',
            bytes,
            width: 0,
            height: 0,
            origin: 'user',
            source: 'mention',
            turn: mention.turn,
            seq: mention.seq,
            time: mention.time,
            sessionId: session.sessionId,
            title,
            workspaceId: owner?.id ?? '',
            workspaceTitle: owner?.title ?? '',
            path: mention.path,
            exists,
          })
        }
        // Agent 写出的工作区文件：同一会话里同一路径只保留最后一次写入
        const lastWrite = new Map()
        for (const write of parsed.writes ?? []) lastWrite.set(write.path, write)
        for (const [writePath, write] of lastWrite) {
          const name = path.basename(writePath)
          if (query !== '' && !name.toLowerCase().includes(query)) continue
          const key = session.sessionId + '|file|' + writePath
          if (seen.has(key)) continue
          seen.set(key, { source: 'tool', seq: write.seq, turn: write.turn })
          scanned += 1
          let exists = false
          let bytes = 0
          try {
            const stat = fs.statSync(writePath)
            exists = stat.isFile()
            bytes = exists ? stat.size : 0
          } catch { exists = false }
          items.push({
            kind: 'file',
            id: '',
            name,
            mediaType: '',
            bytes,
            width: 0,
            height: 0,
            origin: 'agent',
            turn: write.turn,
            seq: write.seq,
            time: write.time,
            sessionId: session.sessionId,
            title,
            workspaceId: owner?.id ?? '',
            workspaceTitle: owner?.title ?? '',
            path: writePath,
            exists,
          })
        }
      }
      for (const attachment of parsed.attachments) {
        if (attachment.kind !== kind) continue
        if (query !== '' && !attachment.name.toLowerCase().includes(query)) continue
        const key = session.sessionId + '|' + attachment.id
        const known = seen.get(key)
        if (known !== undefined) {
          // 已有一条更可信（或更靠后）的记录：替换掉它，保证 turn 指向真正的消息
          if (priorityOf(attachment.source) < priorityOf(known.source)) continue
          if (priorityOf(attachment.source) === priorityOf(known.source) && attachment.seq <= known.seq) continue
          const index = items.indexOf(known)
          if (index >= 0) items.splice(index, 1)
        }
        seen.set(key, attachment)
        scanned += 1
        const filePath = attachmentPathOf(attachment)
        let exists = false
        if (filePath !== null) {
          try { exists = fs.statSync(filePath).isFile() } catch { exists = false }
        }
        items.push({
          ...attachment,
          sessionId: session.sessionId,
          title,
          workspaceId: owner?.id ?? '',
          workspaceTitle: owner?.title ?? '',
          path: filePath,
          exists,
        })
      }
    }
    items.sort((a, b) => b.time - a.time)
    return {
      kind,
      query,
      scope,
      items: items.slice(0, maxHits),
      truncated: items.length > maxHits,
      total: items.length,
      scannedSessions: scopeSessions.length,
      elapsedMs: Date.now() - started,
      skipped,
      maxHits,
    }
  }

  /**
   * 打开附件所在文件夹（Windows 用资源管理器选中该文件）。
   * @param {object} payload - { id, kind }。
   * @returns {{ok: boolean, path: string}} 结果。
   */
  const openAttachment = (payload) => {
    // 工作区文件（Agent 写出）没有 attachment id，直接用绝对路径；
    // 附件则从 id 推导路径，并限制在附件根目录内。
    const direct = typeof payload?.path === 'string' && payload.path !== '' ? path.resolve(payload.path) : null
    const derived = attachmentPathOf({ kind: payload?.kind === 'image' ? 'image' : 'file', id: payload?.id })
    const resolved = direct ?? (derived === null ? null : path.resolve(derived))
    if (resolved === null) throw new Error('附件标识无效')
    if (direct === null) {
      const root = path.resolve(attachmentsRoot)
      if (!resolved.startsWith(root + path.sep)) throw new Error('附件路径越界')
    }
    try {
      if (!fs.statSync(resolved).isFile()) throw new Error('不是文件')
    } catch {
      throw new Error('文件不存在（可能已被移动或清理）')
    }
    const child = spawn('cmd', ['/c', 'explorer', '/select,', resolved], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return { ok: true, path: resolved }
  }

  /** 读取图片字节，返回 data URL（供列表缩略预览）。 */
  const attachmentBlob = (payload) => {
    const filePath = attachmentPathOf({ kind: 'image', id: payload?.id })
    if (filePath === null) throw new Error('附件标识无效')
    const bytes = fs.statSync(filePath).size
    if (bytes > MAX_BLOB_BYTES) throw new Error('图片过大，无法内联预览')
    const data = fs.readFileSync(filePath).toString('base64')
    return { dataUrl: 'data:' + (typeof payload?.mediaType === 'string' && payload.mediaType !== '' ? payload.mediaType : 'image/png') + ';base64,' + data }
  }

  const handleHttp = async (request) => {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    let body
    try {
      body = await request.json()
    } catch {
      return Response.json({ ok: false, error: { code: 'message-search/bad-request', message: '请求体不是 JSON' } }, { status: 400 })
    }
    const op = typeof body?.op === 'string' ? body.op : ''
    const payload = body?.payload !== null && typeof body?.payload === 'object' ? body.payload : {}
    try {
      if (op === 'status') return Response.json({ ok: true, value: status() }, { headers: { 'cache-control': 'no-store' } })
      if (op === 'search') return Response.json({ ok: true, value: search(payload) }, { headers: { 'cache-control': 'no-store' } })
    if (op === 'attachments') return Response.json({ ok: true, value: listAttachments(payload) }, { headers: { 'cache-control': 'no-store' } })
    if (op === 'attachment-open') return Response.json({ ok: true, value: openAttachment(payload) }, { headers: { 'cache-control': 'no-store' } })
    if (op === 'attachment-blob') return Response.json({ ok: true, value: attachmentBlob(payload) }, { headers: { 'cache-control': 'no-store' } })
      return Response.json({ ok: false, error: { code: 'message-search/unknown-op', message: `未知操作 "${op}"` } }, { status: 400 })
    } catch (error) {
      return Response.json({ ok: false, error: { code: 'message-search/failed', message: describe(error) } }, { status: 400 })
    }
  }

  // connection 通常晚于本行就绪：用 ctx.inject 等它出现。
  ctx.inject(['connection'], (child) => {
    const connection = readService(child, 'connection')
    if (connection?.fetch?.register === undefined) {
      console.error('message-search: connection 服务没有 fetch.register，检索页无法读取数据')
      return
    }
    child.effect(
      () => connection.fetch.register({
        path: HTTP_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handleHttp,
      }),
      'message-search: http route',
    )
  })
}
