/**
 * 消息检索 — Client half。
 *
 * 全屏浮层里的检索面板（Ctrl+F 打开）：按「当前会话 / 工作区 / 全部会话」范围检索消息正文，
 * 命中按时间倒序列出（会话标题、工作区、角色、时间、带高亮的片段），回车打开所在会话。
 *
 * 数据来自 Host 半边的 `/api/message-search`（自己扫会话日志），不再依赖 sessionQuery 的
 * 内容索引，因此历史坏日志不会让整次检索失败——那类会话会被跳过并在页脚计数。
 *
 * 样式对齐产品其它页面：0.5px 描边、14px 圆角、`--dsw-alias-*` 主题变量、主按钮用宿主按钮令牌。
 */
window.__ModuleLoader__.load({
  id: 'my-dsh-message-search',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'messageSearch'
    const ROUTE = 'api/message-search'
    const UI_REVISION = '2026-11-19.2'

    const zh = {
      title: '检索消息',
      placeholder: '检索消息正文…',
      placeholderAttach: '按文件名筛选，留空则列出全部',
      modeLabel: '检索对象',
      modeText: '文本',
      modeFile: '附件',
      modeImage: '图片',
      foundFiles: '共 {count} 个附件',
      foundImages: '共 {count} 张图片',
      noFiles: '没有匹配的附件',
      noImages: '没有匹配的图片',
      originUser: '用户上传',
      originMention: '用户引用',
      originAgent: 'Agent 生成',
      openFolder: '打开文件夹',
      locateAttachment: '定位到所在消息',
      jumpFailed: '已打开会话，但没能定位到该消息所在位置',
      jumpTopOnly: '已打开会话并回到顶部（该会话没有轮次导航）',
      missingFile: '文件缺失',
      scopeCurrent: '当前会话',
      scopeWorkspace: '工作区',
      scopeAll: '全部会话',
      workspaceAll: '选择工作区',
      workspaceFallback: '工作区',
      noWorkspace: '暂无工作区',
      searching: '正在检索…',
      found: '命中 {count} 条消息',
      noMatch: '没有匹配的消息',
      idle: '输入关键词开始检索；默认只搜当前会话。',
      needWorkspace: '先选择一个工作区。',
      error: '检索失败：{message}',
      corpus: '范围：{sessions} 个会话 · {messages} 条消息',
      corpusSessions: '范围：{sessions} 个会话',
      foundItems: '共 {count} 项',
      elapsed: '{seconds}',
      truncated: '结果较多，只显示前 {max} 条。',
      skipped: '{count} 个会话日志无法解析，已跳过。',
      emptyNoSession: '当前没有打开的会话；可切到「工作区」或「全部会话」。',
      hint: '↑↓ 选择 · Enter 打开 · Esc 关闭',
      close: '关闭检索',
      clear: '清空',
      openedInExplorer: '已在资源管理器中打开：{name}',
      untitled: '未命名会话',
      ungrouped: '未分组',
      roleUser: '我',
      roleAssistant: '助手',
      matchCount: '{count} 处',
    }

    const en = {
      title: 'Search messages',
      placeholder: 'Search message text…',
      placeholderAttach: 'Filter by file name; leave empty to list all',
      modeLabel: 'Search target',
      modeText: 'Text',
      modeFile: 'Files',
      modeImage: 'Images',
      foundFiles: '{count} files',
      foundImages: '{count} images',
      noFiles: 'No matching files',
      noImages: 'No matching images',
      originUser: 'Uploaded',
      originMention: 'Mentioned',
      originAgent: 'Agent',
      openFolder: 'Open folder',
      locateAttachment: 'Jump to the message',
      jumpFailed: 'Opened the session but could not locate the message',
      jumpTopOnly: 'Opened the session and scrolled to the top (no turn navigation here)',
      missingFile: 'file missing',
      scopeCurrent: 'This session',
      scopeWorkspace: 'Workspace',
      scopeAll: 'All sessions',
      workspaceAll: 'Choose a workspace',
      workspaceFallback: 'Workspace',
      noWorkspace: 'No workspace',
      searching: 'Searching…',
      found: '{count} messages matched',
      noMatch: 'No matching message',
      idle: 'Type a keyword to search; the current session is searched by default.',
      needWorkspace: 'Choose a workspace first.',
      error: 'Search failed: {message}',
      corpus: 'Scope: {sessions} sessions · {messages} messages',
      corpusSessions: 'Scope: {sessions} sessions',
      foundItems: '{count} items',
      elapsed: '{seconds}',
      truncated: 'Showing the first {max} results.',
      skipped: '{count} session logs could not be parsed and were skipped.',
      emptyNoSession: 'No session is open; switch to Workspace or All sessions.',
      hint: '↑↓ select · Enter open · Esc close',
      close: 'Close search',
      clear: 'Clear',
      openedInExplorer: 'Opened in Explorer: {name}',
      untitled: 'Untitled session',
      ungrouped: 'No workspace',
      roleUser: 'You',
      roleAssistant: 'Assistant',
      matchCount: '{count} hits',
    }

    /** 打开/关闭状态（跨组件共享）。 */
    let open = false
    const openListeners = new Set()
    const readOpen = () => open
    function subscribeOpen(listener) {
      openListeners.add(listener)
      return () => { openListeners.delete(listener) }
    }
    function setOpen(next) {
      if (open === next) return
      open = next
      for (const listener of [...openListeners]) listener()
    }

    /** 当前打开的 Session（由 dock 探针发布）。 */
    let currentSessionId
    const sessionListeners = new Set()
    const readCurrentSession = () => currentSessionId
    function subscribeSession(listener) {
      sessionListeners.add(listener)
      return () => { sessionListeners.delete(listener) }
    }
    function setCurrentSession(sessionId) {
      if (currentSessionId === sessionId) return
      currentSessionId = sessionId
      for (const listener of [...sessionListeners]) listener()
    }

    /** Headless dock 条目：把当前会话 id 交给浮层。 */
    function CurrentSessionProbe(props) {
      const sessionId = props.sessionId
      React.useEffect(() => {
        setCurrentSession(sessionId)
        return () => {
          if (currentSessionId === sessionId) setCurrentSession(undefined)
        }
      }, [sessionId])
      return null
    }

    /** 请求 Host 路由。 */
    function createRequest() {
      return async function request(op, payload) {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, payload: payload ?? {} }),
        })
        const result = await response.json().catch(() => null)
        if (result === null || result.ok !== true) {
          const failure = new Error(result?.error?.message ?? `HTTP ${String(response.status)}`)
          failure.code = result?.error?.code ?? 'message-search/transport'
          throw failure
        }
        return result.value
      }
    }

    const CSS = `
.msn-layer{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.22)}
body[data-ds-dark-theme] .msn-layer{background:rgba(0,0,0,.55)}
.msn-card{width:min(680px,100%);height:min(74vh,580px);display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:28px;box-shadow:0 0 0 0.5px rgba(0,0,0,.16),0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05);overflow:hidden}
.msn-head{display:flex;align-items:center;gap:10px;padding:22px 14px 2px 24px}
.msn-title{flex:1;min-width:0;margin:0;font-size:16px;line-height:24px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msn-sub{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.msn-close{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-caption);cursor:pointer}
.msn-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.msn-bar{display:flex;align-items:center;gap:6px;margin:12px 24px 0;height:40px;box-sizing:border-box;padding:0 6px 0 14px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:transparent}
.msn-bar:focus-within{border-color:var(--dsw-alias-label-caption)}
.msn-input{flex:1 1 auto;min-width:0;height:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;padding:0;outline:none}
.msn-clear{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-caption);cursor:pointer}
.msn-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.msn-input::placeholder{color:var(--dsw-alias-label-caption)}
.msn-scopes{position:relative;display:flex;align-items:center;gap:2px;flex:none}
.msn-scope{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:var(--dsw-alias-label-caption);font-size:12.5px;line-height:20px;padding:5px 9px;border-radius:8px;cursor:pointer;white-space:nowrap;max-width:170px}
.msn-scope:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.msn-scope[aria-pressed='true']{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}
.msn-scope:disabled{opacity:.4;cursor:not-allowed}
.msn-scope-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msn-scope-caret{flex:none;opacity:.7}
.msn-menu{position:absolute;top:calc(100% + 10px);right:0;z-index:3;min-width:200px;max-width:260px;max-height:260px;overflow:auto;padding:5px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.16)}
.msn-menu-item{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;padding:7px 10px;border-radius:8px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msn-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.msn-menu-item[data-current='true']{font-weight:500}
.msn-menu-check{display:inline-flex;width:16px;flex:none;justify-content:center;color:var(--dsw-alias-label-primary)}
.msn-menu-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msn-menu-empty{padding:8px 10px;font-size:12.5px;color:var(--dsw-alias-label-caption)}
.msn-status{display:flex;align-items:center;gap:10px;padding:10px 24px 6px;font-size:12.5px;color:var(--dsw-alias-label-caption);min-height:28px}
.msn-status-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msn-modes{display:inline-flex;align-items:center;gap:2px;flex:none;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-module-platform)}
.msn-mode{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-caption);font:inherit;font-size:12px;line-height:18px;padding:2px 8px;border-radius:7px;cursor:pointer}
.msn-mode:hover{color:var(--dsw-alias-label-primary)}
.msn-mode[aria-pressed='true']{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.msn-attach{display:flex;align-items:stretch;gap:6px;border-radius:12px;padding:2px}
.msn-attach:hover,.msn-attach[data-active='true']{background:var(--dsw-alias-interactive-bg-hover)}
.msn-attach-main{flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:8px 10px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.msn-ext{flex:none;width:38px;height:44px;border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:0.5px solid currentColor}
.msn-ext-label{font-size:8.5px;font-weight:600;letter-spacing:.02em;line-height:1;max-width:34px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msn-ext-doc{color:#2f5bd7;background:rgba(47,91,215,.10)}
.msn-ext-sheet{color:#137a4a;background:rgba(19,122,74,.10)}
.msn-ext-slides{color:#b4531a;background:rgba(180,83,26,.10)}
.msn-ext-pdf{color:#c02b2b;background:rgba(192,43,43,.10)}
.msn-ext-archive{color:#8a6512;background:rgba(138,101,18,.12)}
.msn-ext-text{color:#556069;background:rgba(85,96,105,.10)}
.msn-ext-code{color:#6b46c1;background:rgba(107,70,193,.10)}
.msn-ext-image{color:#0d7c86;background:rgba(13,124,134,.10)}
.msn-ext-other{color:#6b7280;background:rgba(107,114,128,.10)}
.msn-attach-body{flex:1;min-width:0;display:block}
.msn-attach-l1{display:flex;align-items:baseline;gap:8px;min-width:0}
.msn-attach-name{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none;max-width:52%}
.msn-attach-name[data-gone='true']{text-decoration:line-through;text-decoration-thickness:1px;color:var(--dsw-alias-label-caption)}
.msn-attach-title{font-size:12px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.msn-attach-l2{display:flex;align-items:center;gap:8px;margin-top:3px;font-size:12px;color:var(--dsw-alias-label-caption)}
.msn-attach-time,.msn-attach-size{font-variant-numeric:tabular-nums}
.msn-attach-open{flex:none;align-self:center;margin-right:6px;appearance:none;border:0.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;cursor:pointer}
.msn-attach-open:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-caption)}
.msn-thumb{flex:none;width:44px;height:44px;border-radius:8px;object-fit:cover;background:var(--dsw-alias-bg-module-platform)}
.msn-gallery{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:grid;grid-template-columns:repeat(auto-fill,minmax(136px,1fr));grid-auto-rows:min-content;gap:10px;padding:6px 14px 12px;align-content:start}
.msn-tile{position:relative;border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-module-platform);border:0.5px solid var(--dsw-alias-border-l4)}
.msn-tile[data-active='true']{border-color:var(--dsw-alias-label-caption);box-shadow:0 0 0 1px var(--dsw-alias-label-caption)}
.msn-tile-hit{display:block;width:100%;padding:0;border:0;background:transparent;cursor:pointer}
.msn-tile-img{display:block;width:100%;height:104px;object-fit:cover;background:var(--dsw-alias-bg-module-platform)}
.msn-tile-empty{display:block;width:100%;height:104px;background:var(--dsw-alias-interactive-bg-hover)}
.msn-tile-meta{display:flex;align-items:center;gap:6px;padding:5px 8px 6px;font-size:11px;color:var(--dsw-alias-label-caption)}
.msn-tile-time{margin-left:auto;font-variant-numeric:tabular-nums}
.msn-tile-open:disabled{opacity:.4;cursor:default}
.msn-tile-gone{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);color:#fff;font-size:12px;pointer-events:none}
.msn-attach-open:disabled{opacity:.45;cursor:default}
.msn-tile-open{position:absolute;top:6px;right:6px;opacity:0;transition:opacity .15s ease;appearance:none;border:0.5px solid rgba(255,255,255,.35);background:rgba(0,0,0,.55);color:#fff;font:inherit;font-size:11px;line-height:16px;padding:2px 8px;border-radius:999px;cursor:pointer}
.msn-tile:hover .msn-tile-open,.msn-tile[data-active='true'] .msn-tile-open{opacity:1}
.msn-thumb-empty{display:inline-block}
.msn-missing{color:var(--dsw-alias-state-error-primary)}
.msn-note-warn{color:var(--dsw-alias-state-error-primary)}
.msn-status-error{color:var(--dsw-alias-state-error-primary)}
.msn-note{padding:0 24px 8px;font-size:12px;color:var(--dsw-alias-label-caption)}
.msn-list{flex:1;margin:0;padding:6px 14px 10px;list-style:none;overflow:auto;border-top:0.5px solid var(--dsw-alias-border-l4);min-height:0}
.msn-body{flex:1;min-height:0;display:flex;flex-direction:column;border-top:0.5px solid var(--dsw-alias-border-l4)}
.msn-body-empty{flex:1;display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--dsw-alias-label-caption)}
.msn-row{display:block;width:100%;padding:10px 12px;border:0;border-radius:12px;text-align:left;background:transparent;color:inherit;font:inherit;cursor:pointer}
.msn-row:hover,.msn-row[data-active='true']{background:var(--dsw-alias-interactive-bg-hover)}
.msn-row-head{display:flex;align-items:baseline;gap:8px;min-width:0}
.msn-row-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msn-row-where{font-size:12px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.msn-row-time{margin-left:auto;flex:none;font-size:11.5px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.msn-row-snippet{margin-top:4px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.msn-mark{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 26%,transparent);color:var(--dsw-alias-label-primary);border-radius:3px;padding:0 1px}
.msn-badge{flex:none;font-size:11px;line-height:18px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-caption);white-space:nowrap}
.msn-empty{padding:18px 24px 24px;text-align:center;font-size:13px;color:var(--dsw-alias-label-caption)}
.msn-foot{display:flex;justify-content:space-between;gap:12px;padding:10px 24px 16px;font-size:12px;color:var(--dsw-alias-label-caption)}
`

    /** 片段高亮。 */
    function renderSnippet(text, query) {
      const raw = typeof text === 'string' ? text : ''
      const needle = query.trim()
      if (raw === '' || needle === '') return raw
      const lower = raw.toLowerCase()
      const target = needle.toLowerCase()
      const parts = []
      let from = 0
      let index = lower.indexOf(target)
      let key = 0
      while (index !== -1 && key < 40) {
        if (index > from) parts.push(raw.slice(from, index))
        parts.push(h('mark', { key: `m${String(key)}`, className: 'msn-mark' }, raw.slice(index, index + needle.length)))
        from = index + needle.length
        index = lower.indexOf(target, from)
        key += 1
      }
      if (from < raw.length) parts.push(raw.slice(from))
      return parts
    }

    /** 用时显示：不足 1 秒给毫秒，超过给一位小数秒。 */
    function elapsedText(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '0 ms'
      return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)}s`
    }

    /** 时间显示。 */
    function timeText(value) {
      if (!Number.isFinite(value) || value <= 0) return ''
      const date = new Date(value)
      const now = new Date()
      const sameDay = date.toDateString() === now.toDateString()
      const pad = (n) => String(n).padStart(2, '0')
      return sameDay
        ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
        : `${String(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * 在渲染出来的会话正文里定位命中消息并滚动过去。
     *
     * 搜索是 Host 直接扫日志得来的，消息没有任何 DOM id，所以定位靠"文本比对"：
     * 两边都去掉空白与 markdown 记号后做子串匹配，取包含该文本的最深层元素，
     * 再 scrollIntoView + 闪一下高亮。目标还没加载出来时，把滚动容器顶到最上面
     * 触发"加载更早"，反复重试若干轮。
     *
     * @param {{snippet?: string, count?: number}} hit - 命中的片段。
     * @returns {void}
     */
    /** 兜底提示：定位过程中任何异常都别静默。 */
    function locateFailed(message) {
      const node = document.createElement('div')
      node.textContent = '定位失败：' + message
      node.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:1301;padding:8px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);border:0.5px solid var(--dsw-alias-border-l4);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12.5px'
      document.body.append(node)
      window.setTimeout(() => node.remove(), 6000)
    }

    /**
     * 定位入口：包一层 try/catch，出错时给出明确提示而不是静默。
     * @param {{snippet?: string, turn?: number}} hit - 命中。
     */
    function locateMessage(hit, keyword = '') {
      try {
        locateMessageInner(hit, keyword)
      } catch (error) {
        locateFailed(error instanceof Error ? error.message : String(error))
      }
    }

    function locateMessageInner(hit, keyword = '') {
      if (typeof document === 'undefined') return
      // 优先用从关键词开始的 match：片段开头是前置上下文，拿它定位会偏到上一行
      const raw = String(hit?.match ?? hit?.snippet ?? '').replace(/^…/, '').replace(/…$/, '')
      const norm = (value) => String(value ?? '').replace(/\s+/g, '').replace(/[*_`#<>|]/g, '')
      const needle = norm(raw)
      if (needle.length < 4) return
      const head = needle.slice(0, 12)

      /** 底部轻提示；ttl<=0 表示常驻，由调用方移除。 */
      const toast = (message, ttl = 3200) => {
        const node = document.createElement('div')
        node.textContent = message
        node.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:1300;padding:8px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l4);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12.5px;transition:opacity .2s ease'
        document.body.append(node)
        if (ttl > 0) window.setTimeout(() => node.remove(), ttl)
        return node
      }

      /**
       * 画一个跟随目标元素的浮层高亮。
       * 不能只给节点加 class：会话是 React 渲染的，懒加载/流式更新会重建节点，
       * 加上的 class 会随旧节点一起消失。浮层挂在 body 上，每帧按目标元素的位置重画，
       * 节点被替换时按文本重新找回来。
       */
      const paintFlash = (first) => {
        const box = document.createElement('div')
        box.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:1290;border-radius:8px;background:rgba(255,205,0,.32);box-shadow:0 0 0 2px rgba(255,205,0,.65);transition:opacity .45s ease;opacity:1'
        document.body.append(box)
        let target = first
        const started = performance.now()
        const draw = () => {
          if (!target.isConnected) {
            const again = findNode()
            if (again !== null) target = again
          }
          if (target.isConnected) {
            const rect = target.getBoundingClientRect()
            if (rect.width > 2 && rect.height > 2) {
              box.style.left = `${rect.left}px`
              box.style.top = `${rect.top}px`
              box.style.width = `${rect.width}px`
              box.style.height = `${rect.height}px`
            }
          }
          if (performance.now() - started > 3200) {
            box.style.opacity = '0'
            window.setTimeout(() => box.remove(), 500)
            return
          }
          requestAnimationFrame(draw)
        }
        requestAnimationFrame(draw)
      }

      // 片段可能跨过块边界（标题 + 正文是不同元素），所以从长到短准备几档前缀：
      // 长档更精确，短档用来兜住"只命中某个块"的情况。越靠前优先级越高。
      const tries = [needle, needle.slice(0, 60), needle.slice(0, 30), needle.slice(0, 16), needle.slice(0, 12), needle.slice(0, 8), needle.slice(0, 6)]
        .filter((value, index, list) => value.length >= 6 && list.indexOf(value) === index)
      // 预筛用最短档的前缀：长前缀可能横跨两个块，任何单个元素都不包含它。
      // 预筛用最短那一档（6~8 字）：片段可能横跨标题/正文多个块，
      // 长前缀会谁都匹配不上；具体挑哪个块由下面的 rank（匹配长度）决定。
      const probe = tries[tries.length - 1]

      /**
       * 在正文区域里找包含目标文本的元素：先取更长的匹配档，再取更小的元素。
       * 命中后要求元素确实占据版面（宽高非 0）——折叠块、隐藏副本也会包含这段文本，
       * 但它们的 rect 是 0，画出来的高亮会是"看不见的 0×0 框"。
       */
      /**
       * 找真正在滚动的容器：会话已滚到底时真容器 scrollTop > 0，
       * 外层包装（overflow: visible）scrollTop 恒为 0。
       */
      /**
       * 只把关键词本身包成 <mark> 高亮（4 秒后还原），不改动其它文字。
       * @param {Element} root - 已定位到的容器。
       * @param {string} text - 检索词。
       * @returns {number} 高亮了几处。
       */
      const markKeyword = (root, text) => {
        const needle = String(text ?? '').trim()
        if (needle === '' || root === null) return 0
        if (document.getElementById('msn-mark-style') === null) {
          const style = document.createElement('style')
          style.id = 'msn-mark-style'
          style.textContent = 'mark.msn-mark{background:rgba(255,205,0,.55);color:inherit;border-radius:3px;padding:0 1px}'
          document.head.append(style)
        }
        const lowerNeedle = needle.toLowerCase()
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        const targets = []
        let node = walker.nextNode()
        while (node !== null) {
          if (String(node.nodeValue ?? '').toLowerCase().includes(lowerNeedle)) targets.push(node)
          node = walker.nextNode()
        }
        const marks = []
        for (const target of targets) {
          const value = String(target.nodeValue ?? '')
          const lower = value.toLowerCase()
          const fragment = document.createDocumentFragment()
          let cursor = 0
          let index = lower.indexOf(lowerNeedle)
          if (index < 0) continue
          while (index !== -1) {
            if (index > cursor) fragment.append(value.slice(cursor, index))
            const mark = document.createElement('mark')
            mark.className = 'msn-mark'
            mark.textContent = value.slice(index, index + needle.length)
            fragment.append(mark)
            marks.push(mark)
            cursor = index + needle.length
            index = lower.indexOf(lowerNeedle, cursor)
          }
          if (cursor < value.length) fragment.append(value.slice(cursor))
          target.parentNode?.replaceChild(fragment, target)
        }
        if (marks.length === 0) return 0
        window.setTimeout(() => {
          for (const mark of marks) {
            if (!mark.isConnected) continue
            const parent = mark.parentNode
            parent?.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
            parent?.normalize?.()
          }
        }, 4000)
        return marks.length
      }

      /** 定位到节点后的呈现：优先只染关键词，实在找不到关键词才退回整体描边。 */
      const showHit = (node) => {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' })
        if (markKeyword(node, keyword) === 0) paintFlash(node)
        window.setTimeout(() => {
          if (node.isConnected) node.scrollIntoView({ block: 'center', behavior: 'auto' })
        }, 450)
      }

      const pickScroller = () => {
        const chat = document.querySelector('[data-conversation-region="chat"]')
        if (chat === null) return null
        const list = []
        if (chat.scrollHeight > chat.clientHeight + 20) list.push(chat)
        for (const element of chat.querySelectorAll('*')) {
          if (element.clientHeight > 120 && element.scrollHeight > element.clientHeight + 20) list.push(element)
        }
        if (list.length === 0) return null
        const scrolled = list.filter(el => el.scrollTop > 0)
        if (scrolled.length > 0) return scrolled.sort((a, b) => b.scrollTop - a.scrollTop)[0]
        return list[0]
      }

      // 归一化结果按元素缓存：定位期间同一批节点会反复比对
      // 文本命中但不可见的元素（折叠区块里的内容），用于"先展开再定位"
      let hiddenMatch = null
      const textCache = new WeakMap()
      const normOf = (element) => {
        let value = textCache.get(element)
        if (value === undefined) {
          value = norm(element.textContent)
          textCache.set(element, value)
        }
        return value
      }

      const findNode = () => {
        // 正文不一定挂在 chat region 内部（有的布局把消息渲染到兄弟层），
        // 所以先看 region 里有没有这段文本，没有就退回整个文档。
        const region = document.querySelector('[data-conversation-region="chat"]')
        const area = region === null ? null : region.getBoundingClientRect()
        const root = pickScroller() ?? document.body
        const candidates = []
        hiddenMatch = null
        let hiddenLength = Number.POSITIVE_INFINITY
        for (const element of root.querySelectorAll('div,p,span,li,td,pre,code,h1,h2,h3,h4,h5,h6,strong,em,a,blockquote')) {
          const text = element.textContent
          if (text === null || text.length === 0 || text.length > 8000) continue
          // 检索面板自己的命中行也含这段文字，必须排除，否则会高亮到弹窗里
          if (element.closest('.msn-card') !== null) continue
          const value = normOf(element)
          if (!value.includes(probe)) continue
          const rank = tries.findIndex(candidate => value.includes(candidate))
          if (rank < 0) continue
          const rect = element.getBoundingClientRect()
          if (rect.width < 3 || rect.height < 3) {
            // 不可见：可能是折叠区块里的内容（只认横向落在正文列内的，避免误报）
            const inColumn = area === null || (rect.right > area.left + 1 && rect.left < area.right - 1)
            if (inColumn && value.length < hiddenLength) { hiddenMatch = element; hiddenLength = value.length }
            continue
          }
          candidates.push({ element, rank, length: value.length })
          if (candidates.length > 2000) break
        }
        // 只判断「横向是否落在正文列内」：纵向位置可能远在视口外（内容已加载但滚走了），
        // 这种情况仍应视为命中，随后交给 scrollIntoView 去滚。
        const inside = (rect) => area === null
          || (rect.right > area.left + 1 && rect.left < area.right - 1)
        // 先比"匹配到的长度"（rank 越小匹配越长），再比元素文本长度（越短越贴近命中）
        candidates.sort((a, b) => (a.rank - b.rank) || (a.length - b.length))
        const viewport = window.innerWidth * window.innerHeight
        for (const item of candidates.slice(0, 24)) {
          const rect = item.element.getBoundingClientRect()
          if (rect.width < 3 || rect.height < 3) continue
          if (!inside(rect)) continue
          // 整屏大小的容器只是祖先节点：命中它等于把整页都框起来
          // 只排除整页级容器（body/根节点）；长消息/长表格本身很大，不能误杀
          if (rect.width * rect.height > viewport * 3) continue
        /** 在命中的容器里继续向下找"仍然包含匹配文本"的最小元素，避免高亮整条消息。 */
        const tighten = (element) => {
          let current = element
          for (let depth = 0; depth < 12; depth += 1) {
            const child = [...current.children].find(c => tries.some(candidate => normOf(c).includes(candidate)))
            if (child === undefined) return current
            current = child
          }
          return current
        }
          return tighten(item.element)
        }
        return null
      }

      const locating = toast('正在准备定位…', 0)
      const LIMIT_MS = 3500
      let waited = 0
      let jumped = false

      /** 会话标题是否已经切到目标会话（页头面包屑里能看到命中标题的前几个字）。 */
      const headerMatches = () => {
        const title = String(hit?.title ?? '').trim()
        if (title === '') return true
        const crumbs = [...document.querySelectorAll('[class*="crumbSeg"],[class*="sessionHeader"]')]
        const probe = title.slice(0, 8)
        return crumbs.some(el => el.textContent.includes(probe))
      }

      /** 轮次导航按钮是否已经出现（说明正文已渲染、可以跳轮）。 */
      const turnButtons = () => [...document.querySelectorAll('[aria-label]')]
        .filter(el => /^(加载并)?跳转到第 \d+ 轮$/.test(el.getAttribute('aria-label') ?? ''))

      const fail = (message) => {
        locating.remove()
        toast(message, 6000)
      }

      const afterJump = () => {
        const node = findNode()
        if (node !== null) {
          locating.remove()
          node.scrollIntoView({ block: 'center', behavior: 'smooth' })
          showHit(node)
          window.setTimeout(() => {
            if (node.isConnected) node.scrollIntoView({ block: 'center', behavior: 'auto' })
          }, 450)
          return
        }
        if (waited > LIMIT_MS) {
          fail(hiddenMatch === null
            ? '已跳到第 ' + String(hit?.turn ?? '?') + ' 轮，但没在正文里找到这条消息（可能在这一轮的折叠区块里）'
            : '这条消息在折叠的步骤/工具区块里，先手动展开该区块再试')
          return
        }
        waited += 350
        locating.textContent = '正在定位到该消息…（第 ' + String(hit?.turn ?? '?') + ' 轮，已等 ' + (waited / 1000).toFixed(1) + 's）'
        window.setTimeout(afterJump, 350)
      }

      const jump = () => {
        const turn = Number(hit?.turn ?? 0)
        const labels = ['跳转到第 ' + String(turn) + ' 轮', '加载并跳转到第 ' + String(turn) + ' 轮']
        const target = [...document.querySelectorAll('[aria-label]')]
          .find(el => labels.includes(el.getAttribute('aria-label') ?? ''))
        if (target === undefined) return false
        target.click()
        jumped = true
        locating.textContent = '正在跳转到第 ' + String(turn) + ' 轮…'
        window.setTimeout(afterJump, 700)
        return true
      }

      const poll = () => {
        // 1) 正文里已经有目标文字 → 直接定位
        const node = findNode()
        if (node !== null) {
          locating.remove()
          node.scrollIntoView({ block: 'center', behavior: 'smooth' })
          showHit(node)
          window.setTimeout(() => {
            if (node.isConnected) node.scrollIntoView({ block: 'center', behavior: 'auto' })
          }, 450)
          return
        }
        // 2) 会话已渲染（标题对上了 / 轮次按钮出现）→ 用轮次导航跳过去
        if (!jumped && (headerMatches() || turnButtons().length > 0)) {
          if (jump()) return
        }
        if (waited > LIMIT_MS) {
          fail(headerMatches()
            ? (hiddenMatch === null
              ? '在会话正文里没找到这条消息（不在已加载的内容里）'
              : '这条消息在折叠的步骤/工具区块里，先手动展开该区块再试')
            : '目标会话还没渲染完成，请稍后再试（或先手动打开该会话）')
          return
        }
        waited += 300
        locating.textContent = jumped
          ? '正在定位到该消息…（已等 ' + (waited / 1000).toFixed(1) + 's）'
          : '正在等待会话渲染…（' + (waited / 1000).toFixed(1) + 's）'
        window.setTimeout(poll, 300)
      }
      window.setTimeout(poll, 150)
    }

    /** 检索面板。 */
    /** 按扩展名判断文件类型（决定图标底色与角标文字）。 */
    const FILE_KINDS = {
      docx: ['DOCX', 'doc'], doc: ['DOC', 'doc'], rtf: ['RTF', 'doc'],
      xlsx: ['XLSX', 'sheet'], xls: ['XLS', 'sheet'], csv: ['CSV', 'sheet'],
      pptx: ['PPTX', 'slides'], ppt: ['PPT', 'slides'],
      pdf: ['PDF', 'pdf'],
      zip: ['ZIP', 'archive'], rar: ['RAR', 'archive'], '7z': ['7Z', 'archive'], gz: ['GZ', 'archive'],
      md: ['MD', 'text'], markdown: ['MD', 'text'], txt: ['TXT', 'text'], log: ['LOG', 'text'],
      json: ['JSON', 'code'], js: ['JS', 'code'], mjs: ['JS', 'code'], cjs: ['JS', 'code'],
      ts: ['TS', 'code'], py: ['PY', 'code'], ps1: ['PS1', 'code'], sh: ['SH', 'code'],
      png: ['PNG', 'image'], jpg: ['JPG', 'image'], jpeg: ['JPG', 'image'], gif: ['GIF', 'image'],
      webp: ['WEBP', 'image'], svg: ['SVG', 'image'], bmp: ['BMP', 'image'],
    }

    /**
     * 文件类型角标：圆角方块 + 文档轮廓 + 扩展名。
     * @param {{name: string}} props - 文件名。
     * @returns {object} React 元素。
     */
    function FileGlyph({ name }) {
      const ext = (/.([A-Za-z0-9]+)$/.exec(String(name ?? ''))?.[1] ?? '').toLowerCase()
      const [label, tone] = FILE_KINDS[ext] ?? [(ext === '' ? 'FILE' : ext.slice(0, 4).toUpperCase()), 'other']
      return h('span', { className: 'msn-ext msn-ext-' + tone, 'aria-hidden': 'true' }, [
        h('svg', {
          key: 'i', viewBox: '0 0 24 24', width: 12, height: 12, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        }, [
          h('path', { key: 'a', d: 'M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z' }),
          h('path', { key: 'b', d: 'M14 3.5V8h4' }),
        ]),
        h('span', { key: 'l', className: 'msn-ext-label' }, label),
      ])
    }

    /** 图片缩略图：按需向 Host 取 data URL。 */
    function AttachmentThumb({ item, request, enabled, variant }) {
      const [url, setUrl] = React.useState(null)
      React.useEffect(() => {
        if (!enabled) return undefined
        let alive = true
        Promise.resolve(request('attachment-blob', { id: item.id, mediaType: item.mediaType }))
          .then((value) => { if (alive) setUrl(value?.dataUrl ?? null) })
          .catch(() => { if (alive) setUrl(null) })
        return () => { alive = false }
      }, [enabled, item.id, item.mediaType, request])
      const mediaClass = variant === 'tile' ? 'msn-tile-img' : 'msn-thumb'
      if (!enabled || url === null) return h('span', { className: (variant === 'tile' ? 'msn-tile-empty' : 'msn-thumb msn-thumb-empty') })
      return h('img', { className: mediaClass, src: url, alt: item.name, loading: 'lazy' })
    }

    function SearchPanel(props) {
      const tr = props.translate
      const request = props.request
      const isOpen = React.useSyncExternalStore(subscribeOpen, readOpen, readOpen)
      const sessionId = React.useSyncExternalStore(subscribeSession, readCurrentSession, readCurrentSession)

      const [query, setQuery] = React.useState('')
      const [scope, setScope] = React.useState('current')
      const [workspaces, setWorkspaces] = React.useState([])
      const [workspaceId, setWorkspaceId] = React.useState('')
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [phase, setPhase] = React.useState('idle')
      const [result, setResult] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [elapsed, setElapsed] = React.useState(0)
      const [activeIndex, setActiveIndex] = React.useState(0)
      // 结果对应的检索签名：query|scope|workspace。签名变化就清空旧结果，
      // 免得"改了范围还按 Enter"时打开的是上一次的命中。
      const [searchedFor, setSearchedFor] = React.useState('')
      // 检索模式：文本 / 附件 / 图片。附件与图片允许空关键词（=列出全部）。
      const [mode, setMode] = React.useState('text')
      const signature = `${mode}|${query.trim()}|${scope}|${workspaceId}`
      const stale = searchedFor !== signature

      const requestRef = React.useRef(request)
      requestRef.current = request
      const abortRef = React.useRef(null)
      const startedRef = React.useRef(0)
      const inputRef = React.useRef(null)
      const cardRef = React.useRef(null)

      // hover 菜单：进 120ms 才展开，出 180ms 才收起，避免手抖
      const hoverTimer = React.useRef(0)
      const openMenu = () => {
        window.clearTimeout(hoverTimer.current)
        hoverTimer.current = window.setTimeout(() => setMenuOpen(true), 120)
      }
      const closeMenuSoon = () => {
        window.clearTimeout(hoverTimer.current)
        hoverTimer.current = window.setTimeout(() => setMenuOpen(false), 180)
      }
      const cancelClose = () => window.clearTimeout(hoverTimer.current)
      React.useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

      // 默认工作区：当前会话所在的那一个，没有就用第一个
      const currentWorkspace = Array.isArray(workspaces)
        ? (workspaces.find(item => Array.isArray(item.sessionIds) && sessionId !== undefined && item.sessionIds.includes(sessionId)) ?? workspaces[0])
        : undefined
      const workspaceTitle = currentWorkspace?.title ? currentWorkspace.title : tr('workspaceFallback')

      React.useEffect(() => {
        if (currentWorkspace === undefined) return
        setWorkspaceId(current => (current === '' || !workspaces.some(item => item.id === current) ? currentWorkspace.id : current))
      }, [currentWorkspace?.id, workspaces])

      React.useEffect(() => {
        if (!isOpen) return
        let alive = true
        void (async () => {
          try {
            const value = await requestRef.current('status')
            if (!alive) return
            setWorkspaces(Array.isArray(value?.workspaces) ? value.workspaces : [])
          } catch {
            /* 状态读不到不影响检索 */
          }
        })()
        return () => { alive = false }
      }, [isOpen])

      const wasOpenRef = React.useRef(false)
      React.useEffect(() => {
        // 只在"关 → 开"的那一次给默认范围：有当前会话就搜当前会话，否则搜全部。
        // 不能依赖 sessionId 变化，否则探针晚到会把用户手动选的范围冲掉。
        if (isOpen && !wasOpenRef.current) { setScope(sessionId === undefined ? 'all' : 'current'); setMenuOpen(false); setNotice(null) }
        if (!isOpen) setMenuOpen(false)
        wasOpenRef.current = isOpen
      }, [isOpen, sessionId])

      React.useEffect(() => {
        if (!isOpen) return undefined
        const handle = window.setTimeout(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        }, 0)
        return () => { window.clearTimeout(handle) }
      }, [isOpen])

      React.useEffect(() => {
        if (phase !== 'searching') return undefined
        const handle = window.setInterval(() => setElapsed(performance.now() - startedRef.current), 100)
        return () => { window.clearInterval(handle) }
      }, [phase])

      const signatureRef = React.useRef('')
      signatureRef.current = signature

      const run = React.useCallback(async () => {
        const keyword = query.trim()
        const listing = mode !== 'text'
        if (!listing && keyword === '') { setPhase('idle'); setResult(null); setFailure(null); return }
        if (scope === 'workspace' && workspaceId === '') { setPhase('idle'); setResult(null); setFailure(null); return }
        const sig = signatureRef.current
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        startedRef.current = performance.now()
        setPhase('searching')
        setFailure(null)
        setElapsed(0)
        try {
          const value = listing
            ? await requestRef.current('attachments', {
              query: keyword,
              kind: mode,
              scope,
              sessionId: scope === 'current' ? sessionId : undefined,
              workspaceId: scope === 'workspace' ? workspaceId : undefined,
            })
            : await requestRef.current('search', {
              query: keyword,
              scope,
              sessionId: scope === 'current' ? sessionId : undefined,
              workspaceId: scope === 'workspace' ? workspaceId : undefined,
            })
          if (controller.signal.aborted || signatureRef.current !== sig) return
          setResult(value)
          setSearchedFor(sig)
          setPhase('done')
          setActiveIndex(0)
          setElapsed(performance.now() - startedRef.current)
        } catch (error) {
          if (controller.signal.aborted || signatureRef.current !== sig) return
          setResult(null)
          setFailure(error instanceof Error ? error.message : String(error))
          setPhase('error')
          setElapsed(performance.now() - startedRef.current)
        }
      }, [query, scope, sessionId, workspaceId, mode])

      const hits = stale ? [] : (result?.hits ?? [])
      const attachments = stale ? [] : (result?.items ?? [])
      React.useEffect(() => { setActiveIndex(0) }, [result])

      React.useEffect(() => {
        // 输入或范围一变，旧结果立刻失效 —— 连"上次搜的是哪个签名"也一起清掉，
        // 否则把关键词改回上一次的值时会误判成"已有结果"，既不自动检索也拿不到列表。
        setResult(null)
        setSearchedFor('')
        setPhase('idle')
        setFailure(null)
      }, [signature])

      /** 点轮次导航按钮跳到第 N 轮（会话自己负责滚动）。 */
      const jumpToTurn = (turn) => {
        if (!Number.isFinite(turn) || turn <= 0) return false
        const labels = ['跳转到第 ' + String(turn) + ' 轮', '加载并跳转到第 ' + String(turn) + ' 轮']
        const target = [...document.querySelectorAll('[aria-label]')]
          .find(el => labels.includes(el.getAttribute('aria-label') ?? ''))
        if (target === undefined) return false
        target.click()
        return true
      }

      const [notice, setNotice] = React.useState(null)

      /** 打开附件所在文件夹（资源管理器定位到文件）。 */
      const openFolder = async (item) => {
        try {
          await requestRef.current('attachment-open', { id: item.id, kind: item.kind, path: item.path })
          setNotice(null)
          // 资源管理器可能被系统放在后台，这里给一条明确反馈
          toast(tr('openedInExplorer', { name: item.name !== '' ? item.name : tr('openFolder') }))
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        }
      }

      /**
       * 跳到某一轮后，尽量把图片本身滚进视口：会话把图片渲染成 data URL，
       * 其长度约为字节数的 4/3，用这个特征在正文里认出同一张图。
       */
      const focusImage = (item) => {
        if (item.kind !== 'image' || !item.exists || item.bytes <= 0) return false
        const expected = item.bytes * 4 / 3
        const images = [...document.querySelectorAll('img')]
          .filter(el => typeof el.src === 'string' && el.src.startsWith('data:image/'))
        const match = images.find(el => Math.abs(el.src.length - expected) / expected < 0.06)
        if (match === undefined) return false
        match.scrollIntoView({ block: 'center', behavior: 'smooth' })
        match.style.outline = '2px solid rgba(255,205,0,.95)'
        match.style.outlineOffset = '2px'
        window.setTimeout(() => {
          match.style.outline = ''
          match.style.outlineOffset = ''
        }, 2600)
        return true
      }

      /** 轻提示：浮在窗口底部，3 秒消失（不占检索面板版面）。 */
      const toast = (message) => {
        const node = document.createElement('div')
        node.textContent = message
        node.style.cssText = 'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:1300;padding:8px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l4);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12.5px'
        document.body.append(node)
        window.setTimeout(() => node.remove(), 3000)
      }

      /** 会话没有轮次导航时的兜底：滚到正文顶部。 */
      const scrollTranscriptTop = () => {
        const chat = document.querySelector('[data-conversation-region="chat"]')
        if (chat === null) return false
        const list = []
        if (chat.scrollHeight > chat.clientHeight + 20) list.push(chat)
        for (const el of chat.querySelectorAll('*')) {
          if (el.clientHeight > 120 && el.scrollHeight > el.clientHeight + 20) list.push(el)
        }
        const scroller = list.sort((a, b) => b.scrollTop - a.scrollTop)[0]
        if (scroller === undefined) return false
        scroller.scrollTop = 0
        return true
      }

      /** 附件条目：打开会话并跳到它所在的那一轮。 */
      const openAttachmentItem = (item) => {
        setOpen(false)
        props.openSession(item.sessionId)
        const started = performance.now()
        const attempt = () => {
          if (jumpToTurn(item.turn)) {
            setNotice(null)
            window.setTimeout(() => { focusImage(item) }, 700)
            return
          }
          if (performance.now() - started > 4000) {
            // 会话没有轮次导航（例如只有一轮）：滚到正文顶部，并用浮层提示，不再占用检索面板
            const scrolled = item.turn <= 1 && scrollTranscriptTop()
            toast(scrolled ? tr('jumpTopOnly') : tr('jumpFailed'))
            return
          }
          window.setTimeout(attempt, 300)
        }
        window.setTimeout(attempt, 300)
      }

      const openSession = (id, hit) => {
        setOpen(false)
        props.openSession(id)
        if (hit !== undefined) locateMessage(hit, query.trim())
      }

      // 边输边搜：输入、范围、工作区任一变，250ms 无新输入就自动检索，不用回车。
      const autoRef = React.useRef(0)
      React.useEffect(() => {
        if (!isOpen) return undefined
        const keyword = query.trim()
        const listing = mode !== 'text'
        if ((!listing && keyword === '') || (scope === 'workspace' && workspaceId === '')) {
          setPhase('idle')
          setResult(null)
          setFailure(null)
          return undefined
        }
        if (!stale) return undefined
        setPhase('searching')
        setElapsed(0)
        window.clearTimeout(autoRef.current)
        autoRef.current = window.setTimeout(() => { void run() }, 250)
        return () => window.clearTimeout(autoRef.current)
      }, [isOpen, signature, stale, run, mode])
      React.useEffect(() => () => window.clearTimeout(autoRef.current), [])

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          return
        }
        const listLength = mode === 'text' ? hits.length : attachments.length
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActiveIndex(index => Math.min(index + 1, Math.max(listLength - 1, 0)))
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActiveIndex(index => Math.max(index - 1, 0))
          return
        }
        if (event.key === 'Enter') {
          if (event.isComposing) return
          const listing = mode !== 'text'
          const items = listing ? attachments : hits
          const ready = !stale && phase === 'done' && items.length > 0 && items[activeIndex] !== undefined
          if (ready) {
            event.preventDefault()
            if (listing) openAttachmentItem(items[activeIndex])
            else openSession(items[activeIndex].sessionId, items[activeIndex])
          } else {
            // 还没搜出这次的结果：立刻搜，不等防抖
            event.preventDefault()
            window.clearTimeout(autoRef.current)
            void run()
          }
        }
      }

      if (!isOpen) return null

      const workspaceReady = scope !== 'workspace' || workspaceId !== ''
      // 状态行只放"结果/错误/提示"，检索中与无结果交给中间占位区显示一次，
      // 避免同一句话在上下两处重复。
      const listing = mode !== 'text'
      const statusText = phase === 'error'
        ? tr('error', { message: failure ?? '' })
        : phase === 'done'
          ? (listing
            ? tr(mode === 'image' ? 'foundImages' : 'foundFiles', { count: String(attachments.length) })
            : (hits.length === 0 ? '' : tr('found', { count: String(hits.length) })))
          : phase === 'searching'
            ? ''
            : scope === 'workspace' && workspaceId === ''
              ? tr('needWorkspace')
              : scope === 'current' && sessionId === undefined
                ? tr('emptyNoSession')
                : (query.trim() === '' && !listing ? tr('idle') : '')

      const attachmentRows = attachments.map((item, index) => {
        const where = item.workspaceTitle !== '' ? item.workspaceTitle : tr('ungrouped')
        const title = item.title !== '' ? item.title : tr('untitled')
        const size = item.bytes >= 1024 * 1024
          ? (item.bytes / 1024 / 1024).toFixed(1) + ' MB'
          : Math.max(1, Math.round(item.bytes / 1024)) + ' KB'
        return h('li', { key: item.sessionId + '-' + String(item.seq) + '-' + item.id + '-' + String(index) },
          h('div', {
            className: 'msn-attach',
            'data-active': index === activeIndex ? 'true' : undefined,
            onMouseEnter: () => setActiveIndex(index),
          }, [
            h('button', {
              key: 'main', type: 'button', className: 'msn-attach-main',
              onClick: () => openAttachmentItem(item),
              title: tr('locateAttachment'),
            }, [
              h(FileGlyph, { key: 'glyph', name: item.name !== '' ? item.name : item.id }),
              h('span', { key: 'body', className: 'msn-attach-body' }, [
                h('span', { key: 'l1', className: 'msn-attach-l1' }, [
                  h('span', {
                    key: 'n',
                    className: 'msn-attach-name',
                    'data-gone': item.exists ? undefined : 'true',
                  }, item.name !== '' ? item.name : item.id.slice(0, 16)),
                  h('span', { key: 'w', className: 'msn-row-where' }, where),
                  h('span', { key: 't', className: 'msn-attach-title' }, title),
                ]),
                h('span', { key: 'l2', className: 'msn-attach-l2' }, [
                  h('span', {
                    key: 'origin',
                    className: 'msn-badge',
                    'data-origin': item.origin,
                  }, item.source === 'mention'
                    ? tr('originMention')
                    : (item.origin === 'agent' ? tr('originAgent') : tr('originUser'))),
                  h('span', { key: 'time', className: 'msn-attach-time' }, timeText(item.time)),
                  h('span', { key: 's', className: 'msn-attach-size' }, size),
                  item.exists ? null : h('span', { key: 'm', className: 'msn-missing' }, tr('missingFile')),
                ]),
              ]),
            ]),
            h('button', {
              key: 'open', type: 'button', className: 'msn-attach-open',
              disabled: !item.exists,
              onClick: (event) => { event.stopPropagation(); if (item.exists) void openFolder(item) },
              title: item.exists ? tr('openFolder') : tr('missingFile'),
            }, tr('openFolder')),
          ]))
      })

      const galleryTiles = attachments.map((item, index) => {
        const size = item.bytes >= 1024 * 1024
          ? (item.bytes / 1024 / 1024).toFixed(1) + ' MB'
          : Math.max(1, Math.round(item.bytes / 1024)) + ' KB'
        return h('div', {
          key: item.sessionId + '-' + String(item.seq) + '-' + item.id + '-' + String(index),
          className: 'msn-tile',
          'data-active': index === activeIndex ? 'true' : undefined,
          onMouseEnter: () => setActiveIndex(index),
          title: (item.name !== '' ? item.name : item.id) + ' · ' + size,
        }, [
          h('button', {
            key: 'hit', type: 'button', className: 'msn-tile-hit',
            onClick: () => openAttachmentItem(item),
            'aria-label': tr('locateAttachment'),
          }, h(AttachmentThumb, { key: 'img', item, request: requestRef.current, enabled: index < 48, variant: 'tile' })),
          h('div', { key: 'meta', className: 'msn-tile-meta' }, [
            h('span', { key: 'o', className: 'msn-badge', 'data-origin': item.origin },
              item.origin === 'agent' ? tr('originAgent') : tr('originUser')),
            item.exists ? null : h('span', { key: 'm', className: 'msn-missing' }, tr('missingFile')),
            h('span', { key: 't', className: 'msn-tile-time' }, timeText(item.time)),
          ]),
          h('button', {
            key: 'open', type: 'button', className: 'msn-tile-open',
            disabled: !item.exists,
            onClick: (event) => { event.stopPropagation(); if (item.exists) void openFolder(item) },
            title: item.exists ? tr('openFolder') : tr('missingFile'),
          }, tr('openFolder')),
          item.exists ? null : h('span', { key: 'gone', className: 'msn-tile-gone' }, tr('missingFile')),
        ])
      })

      const rows = hits.map((hit, index) => {
        const where = hit.workspaceTitle !== '' ? hit.workspaceTitle : tr('ungrouped')
        const title = hit.title !== '' ? hit.title : tr('untitled')
        return h('li', { key: `${hit.sessionId}-${String(hit.seq)}` },
          h('button', {
            type: 'button',
            className: 'msn-row',
            'data-active': index === activeIndex ? 'true' : undefined,
            onMouseEnter: () => setActiveIndex(index),
            onClick: () => openSession(hit.sessionId, hit),
          }, [
            h('span', { key: 'head', className: 'msn-row-head' }, [
              h('span', { key: 'role', className: 'msn-badge' }, hit.role === 'user' ? tr('roleUser') : tr('roleAssistant')),
              h('span', { key: 't', className: 'msn-row-title' }, title),
              h('span', { key: 'w', className: 'msn-row-where' }, where),
              hit.count > 1 ? h('span', { key: 'c', className: 'msn-badge' }, tr('matchCount', { count: String(hit.count) })) : null,
              h('span', { key: 'time', className: 'msn-row-time' }, timeText(hit.time)),
            ]),
            h('span', { key: 'snip', className: 'msn-row-snippet' }, renderSnippet(hit.snippet, query)),
          ]))
      })

      const footLeft = result === null
        ? ''
        : listing
          ? `${tr('corpusSessions', { sessions: String(result.scannedSessions) })} · ${tr('foundItems', { count: String(result.total ?? attachments.length) })}${result.skipped?.length ? ` · ${tr('skipped', { count: String(result.skipped.length) })}` : ''}`
          : `${tr('corpus', { sessions: String(result.scannedSessions), messages: String(result.scannedMessages) })}${result.skipped?.length ? ` · ${tr('skipped', { count: String(result.skipped.length) })}` : ''}`

      return h('div', {
        className: 'msn-layer',
        onMouseDown: (event) => { if (event.target === event.currentTarget) setOpen(false) },
      }, [
        h('style', { key: 'css' }, CSS),
        h('div', {
          key: 'card',
          ref: cardRef,
          className: 'msn-card',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': tr('title'),
          onKeyDown,
          onMouseDown: (event) => event.stopPropagation(),
        }, [
          h('div', { key: 'head', className: 'msn-head' }, [
            h('h2', { key: 't', className: 'msn-title' }, tr('title')),
            (phase === 'done' || phase === 'error')
              ? h('span', { key: 'e', className: 'msn-sub' }, tr('elapsed', { seconds: elapsedText(elapsed) }))
              : null,
            h('button', {
              key: 'x', type: 'button', className: 'msn-close', 'aria-label': tr('close'),
              onClick: () => setOpen(false),
            }, h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
              [h('path', { key: 'a', d: 'M6 6l12 12' }), h('path', { key: 'b', d: 'M18 6L6 18' })])),
          ]),
          h('div', { key: 'bar', className: 'msn-bar' }, [
            h('input', {
              key: 'i',
              ref: inputRef,
              className: 'msn-input',
              type: 'text',
              value: query,
              placeholder: mode === 'text' ? tr('placeholder') : tr('placeholderAttach'),
              'aria-label': tr('placeholder'),
              onChange: (event) => setQuery(event.target.value),
              onKeyDown,
            }),
            query === ''
              ? null
              : h('button', {
                key: 'clear',
                type: 'button',
                className: 'msn-clear',
                'aria-label': tr('clear'),
                title: tr('clear'),
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => {
                  setQuery('')
                  inputRef.current?.focus()
                },
              }, h('svg', {
                width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
                strokeWidth: 2, strokeLinecap: 'round',
              }, [h('path', { key: 'a', d: 'M6 6l12 12' }), h('path', { key: 'b', d: 'M18 6L6 18' })])),
            h('div', { key: 'scopes', className: 'msn-scopes' }, [
              h('button', {
                key: 'current', type: 'button', className: 'msn-scope',
                'aria-pressed': scope === 'current' ? 'true' : 'false',
                disabled: sessionId === undefined,
                title: tr('scopeCurrent'),
                onMouseEnter: closeMenuSoon,
                onClick: () => { setScope('current'); setMenuOpen(false) },
              }, tr('scopeCurrent')),
              h('div', { key: 'ws', style: { position: 'relative' }, onMouseLeave: closeMenuSoon }, [
                h('button', {
                  key: 'b', type: 'button', className: 'msn-scope',
                  'aria-pressed': scope === 'workspace' ? 'true' : 'false',
                  title: workspaceId === '' ? tr('scopeWorkspace') : workspaceTitle,
                  'aria-haspopup': 'menu',
                  'aria-expanded': menuOpen ? 'true' : 'false',
                  onMouseEnter: openMenu,
                  onClick: () => {
                    if (workspaceId !== '') setScope('workspace')
                    setMenuOpen(value => !value || workspaceId === '')
                  },
                }, [
                  h('span', { key: 'l', className: 'msn-scope-label' }, tr('scopeWorkspace')),
                  h('svg', {
                    key: 'c', className: 'msn-scope-caret', width: 10, height: 10, viewBox: '0 0 24 24',
                    fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
                  }, [h('path', { key: 'p', d: 'M6 9l6 6 6-6' })]),
                ]),
                menuOpen
                  ? h('div', {
                    key: 'm', className: 'msn-menu', role: 'menu',
                    onMouseEnter: cancelClose,
                    onMouseLeave: closeMenuSoon,
                  }, workspaces.length === 0
                    ? [h('div', { key: 'none', className: 'msn-menu-empty' }, tr('noWorkspace'))]
                    : workspaces.map(item => h('button', {
                      key: item.id,
                      type: 'button',
                      className: 'msn-menu-item',
                      role: 'menuitem',
                      'data-current': item.id === workspaceId ? 'true' : undefined,
                      title: item.title,
                      onClick: () => {
                        setWorkspaceId(item.id)
                        setScope('workspace')
                        setMenuOpen(false)
                      },
                    }, [
                      h('span', { key: 'c', className: 'msn-menu-check' }, item.id === workspaceId
                        ? h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' }, [h('path', { key: 'p', d: 'M4 12l5 5L20 6' })])
                        : null),
                      h('span', { key: 'n', className: 'msn-menu-name' }, item.title || item.id),
                    ])))
                  : null,
              ]),
              h('button', {
                key: 'all', type: 'button', className: 'msn-scope',
                'aria-pressed': scope === 'all' ? 'true' : 'false',
                title: tr('scopeAll'),
                onMouseEnter: closeMenuSoon,
                onClick: () => { setScope('all'); setMenuOpen(false) },
              }, tr('scopeAll')),
            ]),
          ]),
          h('div', { key: 'status', className: `msn-status ${phase === 'error' ? 'msn-status-error' : ''}`, 'aria-live': 'polite' }, [
            h('span', { key: 'txt', className: 'msn-status-text' }, statusText),
            h('div', { key: 'modes', className: 'msn-modes', role: 'group', 'aria-label': tr('modeLabel') }, [
              ['text', 'modeText'], ['file', 'modeFile'], ['image', 'modeImage'],
            ].map(([value, key]) => h('button', {
              key: value,
              type: 'button',
              className: 'msn-mode',
              'aria-pressed': mode === value ? 'true' : 'false',
              title: tr(key),
              onClick: () => { setMode(value); setNotice(null) },
            }, tr(key)))),
          ]),
          notice === null ? null : h('div', { key: 'notice', className: 'msn-note msn-note-warn' }, notice),
          result !== null && result.truncated ? h('div', { key: 'trunc', className: 'msn-note' }, tr('truncated', { max: String(result.maxHits) })) : null,
          h('div', { key: 'body', className: 'msn-body' },
            listing
              ? (attachments.length > 0
                ? (mode === 'image'
                  ? h('div', { key: 'gallery', className: 'msn-gallery' }, galleryTiles)
                  : h('ul', { key: 'list', className: 'msn-list' }, attachmentRows))
                : h('div', { key: 'empty', className: 'msn-body-empty' },
                  phase === 'done' ? tr(mode === 'image' ? 'noImages' : 'noFiles') : (phase === 'searching' ? tr('searching') : '')))
              : (hits.length > 0
                ? h('ul', { key: 'list', className: 'msn-list' }, rows)
                : h('div', { key: 'empty', className: 'msn-body-empty' },
                  phase === 'done' ? tr('noMatch') : (phase === 'searching' ? tr('searching') : '')))),
          h('div', { key: 'foot', className: 'msn-foot' }, [
            h('span', { key: 'hint' }, tr('hint')),
            h('span', { key: 'corpus' }, footLeft),
          ]),
        ]),
      ])
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        const translate = ctx.locale.bind(NS)
        const request = createRequest()
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'message-search: dictionaries')

        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const onKeyDown = (event) => {
            if (event.defaultPrevented) return
            if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
            if (event.key !== 'f' && event.key !== 'F') return
            event.preventDefault()
            event.stopPropagation()
            setOpen(!open)
          }
          document.addEventListener('keydown', onKeyDown, true)
          return () => { document.removeEventListener('keydown', onKeyDown, true) }
        }, 'message-search: Ctrl+F shortcut')

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'message-search',
          order: 0,
          locale: NS,
          inject: () => ({
            request,
            translate,
            openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
          }),
        }, SearchPanel))

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'message-search.current-session',
          order: 1000,
        }, CurrentSessionProbe))
      },
    }
  },
})
