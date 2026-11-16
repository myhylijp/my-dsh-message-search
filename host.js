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

export const name = 'message-search'

/** Client 页面读取的私有路由。 */
const HTTP_PATH = '/api/message-search'
/** Host 构建标记。 */
const HOST_REVISION = '2026-11-15.1'
/** 一次检索最多返回多少条命中。 */
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
      if (event.type === 'user/message') {
        const content = textOf(event.data?.content)
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
    const parsed = { mtimeMs: stat.mtimeMs, size: stat.size, title, messages }
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
