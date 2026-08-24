// cc-mode Client half (v59) — composer controls + Claude-shaped tool rows,
// wearing dsh's own chrome.
//
// Nothing here renders a conversation: the transcript is dsh's own, because the
// Host half writes ordinary session events. What this half adds:
//
//   conversation.input.left   engine chip (DSH | Claude Code)
//   conversation.input.model  shadowed while Claude drives, so the model seat
//                             offers Claude's models and effort levels
//   conversation.input.plan   shadowed too: carries Claude's permission posture
//                             in place of dsh's access selector, which is hidden
//   tool.call.toolview        one keyed row per Claude tool name
//
// Styling is not approximated: these components reuse the exact class names of
// dsh's own composer seats (ModelSelect / PermissionSelect) and of its bash tool
// card, so they inherit the shipped CSS instead of imitating it. The names are
// build-scoped hashes — when this becomes a real bundle it imports the same
// modules properly instead.

return {
  // `timer` is declared because the usage readout polls through ctx.interval;
  // the sandbox denies the timer verbs to a plugin that has not declared it.
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) {
      console.error('cc-mode: slots service unavailable — client half idle')
      return
    }

    const h = React.createElement

    // dsh's own CSS-module class names, borrowed verbatim.
    const SEL = {
      root: '_7KE1Ra_root',
      trigger: '_7KE1Ra_trigger',
      triggerLabel: '_7KE1Ra_triggerLabel',
      triggerEffort: '_7KE1Ra_triggerEffort',
      chevron: '_7KE1Ra_chevron',
      chevronOpen: '_7KE1Ra_chevronOpen',
      menu: '_7KE1Ra_menu',
      groups: '_7KE1Ra_groups',
      group: '_7KE1Ra_group',
      groupTitle: '_7KE1Ra_groupTitle',
      option: '_7KE1Ra_option',
      optionCopy: '_7KE1Ra_optionCopy',
      modelName: '_7KE1Ra_modelName',
      description: '_7KE1Ra_description',
      check: '_7KE1Ra_check',
      cell: '_7KE1Ra_cell',
      cellLabel: '_7KE1Ra_cellLabel',
      cellValue: '_7KE1Ra_cellValue',
      cellChevron: '_7KE1Ra_cellChevron',
    }
    const CARD = {
      card: 'CY-8Ka_card',
      root: 'CY-8Ka_root',
      leading: 'CY-8Ka_leading',
      chevron: 'CY-8Ka_chevron',
      iconIdle: 'CY-8Ka_iconIdle',
      chevronHover: 'CY-8Ka_chevronHover',
      title: 'CY-8Ka_title',
      sep: 'CY-8Ka_sep',
      summary: 'CY-8Ka_summary',
      errorSummary: 'CY-8Ka_errorSummary',
      bodyWrap: 'CY-8Ka_bodyWrap',
      ioCard: 'CY-8Ka_ioCard',
      ioSection: 'CY-8Ka_ioSection',
      ioLabel: 'CY-8Ka_ioLabel',
      ioText: 'CY-8Ka_ioText',
      ioDivider: 'CY-8Ka_ioDivider',
    }

    const CHEVRON_DOWN = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'
    const CHEVRON_RIGHT = 'M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24848 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z'
    const CHECK = 'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z'

    function icon(path, size, className, box) {
      return h('svg', {
        width: size, height: size, className: className,
        viewBox: '0 0 ' + (box || size) + ' ' + (box || size),
        fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true,
      }, h('path', { d: path, fill: 'currentColor' }))
    }

    // Only what dsh has no class for: a left-anchored menu and the two previews.
    styles.insert(`
      .ccmode-menu-left { left:0; right:auto; }
      /* dsh's own access selector (PermissionSelect) — replaced, not doubled */
      body[data-ccmode="claude"] .Sh0Q9G_trigger { display:none; }
      .ccmode-diff-add { color:var(--dsw-alias-state-success-primary, #3fb950); }
      .ccmode-diff-del { color:var(--dsw-alias-state-error-primary, #e5484d); }
      .ccmode-todo { list-style:none; margin:0; padding:0; }
      .ccmode-todo li { font-size:12px; line-height:20px; }
      .ccmode-todo li.done { opacity:0.55; text-decoration:line-through; }
      .ccmode-todo li.active { color:var(--dsw-alias-label-primary, inherit); font-weight:500; }
      .ccmode-usage { display:inline-flex; align-items:center; gap:10px; font-size:11px; line-height:1.5;
        color:var(--dsw-alias-label-secondary); white-space:nowrap; user-select:none; }
      .ccmode-usage-dot { width:6px; height:6px; border-radius:50%; flex:none; background:#d97757; }
      .ccmode-usage-plan { color:var(--dsw-alias-label-tertiary, inherit); }
      .ccmode-usage-item { display:inline-flex; align-items:center; gap:4px; }
      .ccmode-usage-label { color:var(--dsw-alias-label-tertiary, inherit); }
      .ccmode-usage-pct { font-weight:600; font-variant-numeric:tabular-nums; }
      .ccmode-pct-ok { color:var(--dsw-alias-state-success-primary, #3fb950); }
      .ccmode-pct-warn { color:#d97706; }
      .ccmode-pct-crit { color:var(--dsw-alias-state-error-primary, #e5484d); }
      .ccmode-usage-error { color:var(--dsw-alias-label-tertiary, inherit); }
      .ccmode-usage-reset { color:var(--dsw-alias-label-caption, #888); font-variant-numeric:tabular-nums; }
      .ccmode-row-badge { color:#d97757; font-size:11px; line-height:1; flex:none; margin-right:2px;
        display:inline-flex; align-items:center; }
      .ccmode-import-scrim { position:fixed; inset:0; z-index:60; background:rgba(0,0,0,0.35);
        display:flex; align-items:center; justify-content:center; }
      .ccmode-import { width:min(720px, 92vw); max-height:78vh; display:flex; flex-direction:column;
        background:var(--dsw-specific-menu, #fff); color:var(--dsw-alias-label-primary, inherit);
        border:1px solid var(--dsw-alias-border-inverted, rgba(128,128,128,0.3)); border-radius:12px;
        box-shadow:var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,0.25)); overflow:hidden; }
      .ccmode-import-head { padding:14px 16px; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2));
        display:flex; flex-direction:column; gap:2px; }
      .ccmode-import-title { font-size:14px; font-weight:600; }
      .ccmode-import-sub { font-size:12px; color:var(--dsw-alias-label-tertiary, #888); }
      .ccmode-import-search { margin-top:10px; width:100%; box-sizing:border-box; padding:7px 10px;
        border-radius:8px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
        background:transparent; color:inherit; font-size:13px; outline:none; }
      .ccmode-import-search:focus { border-color:var(--dsw-alias-border-inverted, rgba(128,128,128,0.55)); }
      .ccmode-import-row-hit { font-size:11px; color:var(--dsw-alias-label-tertiary, #888);
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
      .ccmode-import-body { flex:1; overflow:auto; padding:12px 16px; display:flex; flex-direction:column; gap:10px; }
      .ccmode-import-empty { color:var(--dsw-alias-label-tertiary, #888); font-size:13px; padding:24px 0; text-align:center; }
      .ccmode-import-msg { display:flex; font-size:13px; line-height:1.6; }
      .ccmode-import-msg.user { justify-content:flex-end; }
      .ccmode-import-bubble { max-width:82%; white-space:pre-wrap; word-break:break-word; }
      .ccmode-import-msg.user .ccmode-import-bubble { background:var(--dsw-alias-interactive-bg-selected, rgba(59,130,246,0.12));
        padding:8px 12px; border-radius:14px; }
      .ccmode-import-msg.assistant .ccmode-import-bubble { color:var(--dsw-alias-label-primary, inherit); }
      /* The rail itself wears dsh's own attachment classes (see DSH_RAIL) so it
         is pixel-identical to the shipped one; only the no-preview fallback and
         the remove glyph are ours. */
      .ccmode-rail-fallback { font-size:11px; padding:4px 12px 0;
        color:var(--dsw-alias-label-secondary, inherit); }
      .ccmode-images-chip { display:inline-flex; align-items:center; gap:6px; font-size:11px;
        color:var(--dsw-alias-label-secondary, inherit); white-space:nowrap; }
      .ccmode-images-clear { border:none; background:transparent; color:inherit; cursor:pointer; font-size:11px; padding:0 2px; }
      .ccmode-import-titlerow { display:flex; align-items:center; gap:2px; }
      .ccmode-import-back { border:none; background:transparent; color:inherit; cursor:pointer; font-size:15px;
        padding:2px 8px 2px 0; line-height:1; }
      .ccmode-import-row-live { color:#d97706; font-size:11px; }
      .ccmode-import-ok[disabled] { opacity:0.6; cursor:default; }
      .ccmode-import-role { flex:none; width:38px; color:var(--dsw-alias-label-tertiary, #888); font-size:11px; padding-top:2px; }
      .ccmode-import-text { white-space:pre-wrap; word-break:break-word; min-width:0; }
      .ccmode-import-msg.assistant .ccmode-import-text { color:var(--dsw-alias-label-secondary, inherit); }
      /* a transcript tool call, wearing dsh's card, aligned under the text column */
      .ccmode-import-tool { margin-left:46px; }
      .ccmode-import-tool .CY-8Ka_ioText { max-height:220px; overflow:auto; }
      .ccmode-command .ccmode-import-title { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
      .ccmode-mcp { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; line-height:1.7; }
      .ccmode-mcp-head { font-weight:600; }
      .ccmode-mcp-count { color:var(--dsw-alias-label-tertiary, #888); margin-bottom:8px; }
      .ccmode-mcp-group { margin-top:10px; color:var(--dsw-alias-label-secondary, inherit); font-weight:600; }
      .ccmode-mcp-row { display:flex; gap:8px; align-items:baseline; padding-left:10px; }
      .ccmode-mcp-sep { color:var(--dsw-alias-label-tertiary, #888); }
      .ccmode-mcp-ok { color:var(--dsw-alias-state-success-primary, #3fb950); }
      .ccmode-mcp-bad { color:var(--dsw-alias-state-error-primary, #e5484d); }
      .ccmode-mcp-wait { color:var(--dsw-alias-label-tertiary, #888); }
      .ccmode-mcp-foot { margin-top:12px; color:var(--dsw-alias-label-tertiary, #888); }
      .ccmode-command-out { margin:0; white-space:pre-wrap; word-break:break-word; font-size:12.5px; line-height:1.6;
        font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
      .ccmode-command-error { color:var(--dsw-alias-state-error-primary, #e5484d); }
      .ccmode-import-foot { padding:12px 16px; border-top:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2));
        display:flex; align-items:center; gap:10px; }
      .ccmode-import-note { flex:1; font-size:12px; color:var(--dsw-alias-label-tertiary, #888); }
      .ccmode-import-cancel { padding:6px 14px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
        background:transparent; color:inherit; cursor:pointer; font-size:13px; }
      .ccmode-import-ok { padding:6px 14px; border-radius:8px; border:none; background:#d97757; color:#fff;
        cursor:pointer; font-size:13px; }
      .ccmode-import-row { display:flex; flex-direction:column; gap:2px; align-items:flex-start; width:100%;
        padding:8px 10px; border-radius:8px; border:1px solid transparent; background:transparent; color:inherit;
        cursor:pointer; text-align:left; font:inherit; }
      .ccmode-import-row:hover { background:var(--dsw-alias-interactive-bg-hover-solid, rgba(128,128,128,0.12)); }
      .ccmode-import-row-title { font-size:13px; }
      .ccmode-import-row-meta { font-size:11px; color:var(--dsw-alias-label-tertiary, #888); }
    `)

    // ---------- shared per-session state ----------

    const cache = new Map()
    const listeners = new Set()
    let catalog = { models: [], efforts: [], permissionModes: [] }

    function notify() { for (const fn of listeners) fn() }

    function useStore() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const fn = () => force((n) => n + 1)
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      }, [])
    }

    function stateOf(sessionId) {
      return cache.get(sessionId) || { mode: 'dsh', permissionMode: 'manual', model: '', effort: '', running: false }
    }

    function put(sessionId, state) { cache.set(sessionId, state); notify() }

    function load(sessionId) {
      if (sessionId.length === 0) return
      host.call('state.get', { sessionId: sessionId }).then((state) => put(sessionId, state)).catch(() => {})
      // The host consumes pending images when a turn starts, so the chip's
      // count comes from the host rather than from what this tab remembers.
      host.call('image.pending', { sessionId: sessionId })
        .then((answer) => setImageCount(sessionId, (answer && answer.count) || 0))
        .catch(() => {})
    }

    host.call('catalog', {}).then((value) => { catalog = value; notify() }).catch(() => {})

    // Which conversation the composer currently belongs to, for the paste
    // handler (a document-level listener that gets no props).
    let currentClaudeSessionId = ''

    function sessionIdOf(props) {
      return String(props.sessionId || (props.session && props.session.sessionId) || '')
    }

    // ---------- the model-seat shadow, held only while Claude drives ----------

    // While Claude drives the visible session it takes over dsh's own seats
    // rather than adding chips beside them: the model seat becomes Claude's
    // model + effort, and the access seat becomes Claude's permission posture.
    // dsh's access selector is not a slot (InputBar renders it directly), so it
    // is hidden by a body-scoped rule and our posture chip takes the plan seat,
    // which sits in the very same `.modes` row.
    let shadowDisposers = []
    let shadowHolders = 0

    function acquireShadow() {
      shadowHolders += 1
      if (shadowDisposers.length > 0) return
      try {
        // priority -1: lowest renders, so this seat shadows the shipped one. The
        // dynamic runner assigned a negative priority implicitly; a bundle must
        // say it, or a single slot refuses the second registration at 0.
        shadowDisposers.push(slots.register({ name: 'conversation.input.model', priority: -1 }, ClaudeModelSeat))
      } catch (error) {
        console.error('cc-mode: could not shadow the model seat:', error)
      }
      try {
        shadowDisposers.push(slots.register({ name: 'conversation.input.plan', priority: -1 }, ClaudePostureSeat))
      } catch (error) {
        console.error('cc-mode: could not shadow the access seat:', error)
      }
      // The draft-image rail inside the composer card. Only taken while a
      // Claude conversation is current — a dsh conversation keeps the shipped
      // rail, drop overlay and all.
      try {
        shadowDisposers.push(slots.register({ name: 'conversation.input.attachments', priority: -1 }, PendingImagesChip))
      } catch (error) {
        console.error('cc-mode: could not shadow the attachment rail:', error)
      }
      // The composer dock is a list slot keyed by entry id, and the lowest
      // priority wins a cell — a dynamic package always gets a lower one. So
      // registering under dsh-balance's own id REPLACES its DeepSeek balance
      // readout while Claude drives, and disposing this brings it straight back.
      // dsh-balance itself is untouched; it never learns this happened.
      try {
        shadowDisposers.push(slots.register(
          { name: 'conversation.composer.dock', id: 'dsh-balance', order: 10, label: 'Claude usage', priority: -1 },
          UsageReadout,
        ))
      } catch (error) {
        console.error('cc-mode: could not take over the balance readout:', error)
      }
      document.body.setAttribute('data-ccmode', 'claude')
    }

    function releaseShadow() {
      shadowHolders = Math.max(0, shadowHolders - 1)
      if (shadowHolders > 0 || shadowDisposers.length === 0) return
      for (const dispose of shadowDisposers.splice(0)) {
        try { dispose() } catch (error) { /* already gone */ }
      }
      document.body.removeAttribute('data-ccmode')
    }

    // ---------- a menu that looks like dsh's ----------

    function useDismiss(open, close) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const node = ref.current
          if (node !== null && !node.contains(event.target)) close()
        }
        const onKey = (event) => { if (event.key === 'Escape') close() }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])
      return ref
    }

    /**
     * One composer chip: dsh's trigger markup, dsh's menu panel, our options.
     * `align` puts the panel under the left zone instead of the trailing zone.
     */
    function Select(props) {
      const [open, setOpen] = React.useState(false)
      const ref = useDismiss(open, () => setOpen(false))
      const options = props.options || []
      const current = options.find((option) => option.id === props.value)

      return h('div', { className: SEL.root, ref: ref },
        h('button', {
          type: 'button',
          className: SEL.trigger,
          title: props.title || '',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          disabled: props.disabled === true,
          onClick: () => { if (props.disabled !== true) setOpen(!open) },
        },
          props.glyph === undefined ? null : props.glyph,
          h('span', { className: SEL.triggerLabel }, current ? current.name : props.label),
          props.effort === undefined ? null : h('span', { className: SEL.triggerEffort }, props.effort),
          h('span', { className: SEL.chevron + (open ? ' ' + SEL.chevronOpen : '') }, icon(CHEVRON_DOWN, 14, undefined, 14))),
        open ? h('div', {
          className: SEL.menu + (props.align === 'left' ? ' ccmode-menu-left' : ''),
          role: 'menu',
        },
          h('div', { className: SEL.groups },
            options.map((option) => h('button', {
              key: option.id,
              type: 'button',
              role: 'menuitem',
              className: SEL.option,
              onClick: () => { setOpen(false); if (option.id !== props.value) props.onSelect(option.id) },
            },
              h('span', { className: SEL.optionCopy },
                h('span', { className: SEL.modelName }, option.name),
                option.detail ? h('span', { className: SEL.description }, option.detail) : null),
              h('span', { className: SEL.check }, option.id === props.value ? icon(CHECK, 16, undefined, 16) : null))))) : null)
    }

    // ---------- composer seats ----------

    const CLAUDE_GLYPH = h('span', {
      'aria-hidden': true,
      style: { display: 'inline-flex', color: '#d97757', fontSize: '13px', lineHeight: '20px' },
    }, '✳')

    function EngineChip(props) {
      useStore()
      const sessionId = sessionIdOf(props)
      const state = stateOf(sessionId)
      const claude = state.mode === 'claude'

      // This seat is mounted in every conversation, so it is where the paste
      // handler learns which session the composer belongs to. The pending-image
      // chip cannot do that job: it only renders once images exist.
      currentClaudeSessionId = claude ? sessionId : ''

      // A started turn ate the pending images; refresh the chip against the host.
      React.useEffect(() => {
        if (state.running !== true) return
        host.call('image.pending', { sessionId: sessionId })
          .then((answer) => setImageCount(sessionId, (answer && answer.count) || 0))
          .catch(() => {})
      }, [sessionId, state.running])

      React.useEffect(() => { load(sessionId) }, [sessionId])

      // The lock flips the moment this session's first turn produces a message,
      // so the seat re-reads it on a slow beat rather than staying stale.
      React.useEffect(() => {
        if (sessionId.length === 0 || state.locked === true) return undefined
        const stop = ctx.interval(() => load(sessionId), 5000)
        return () => { stop() }
      }, [sessionId, state.locked])

      React.useEffect(() => {
        if (!claude) return undefined
        acquireShadow()
        return () => { releaseShadow() }
      }, [claude])

      function choose(next) {
        if (state.locked === true) return
        put(sessionId, Object.assign({}, state, { mode: next }))
        host.call('mode.set', { sessionId: sessionId, mode: next })
          .then((answer) => { put(sessionId, answer); if (next === 'claude') refreshClaudeCommands() })
          .catch((error) => console.error('cc-mode: switching engine failed:', error))
      }

      // A conversation belongs to one engine for life: the two keep separate
      // histories (Claude's own transcript never sees a dsh turn), so the seat
      // locks as soon as this session has taken its first turn.
      const locked = state.locked === true
      return h(Select, {
        value: state.mode,
        onSelect: choose,
        align: 'left',
        disabled: locked,
        glyph: claude ? CLAUDE_GLYPH : undefined,
        label: 'DSH',
        title: locked
          ? (claude
              ? '这个会话已经是 Claude Code 对话，不能改回 DSH——两边的历史不共享。要用 DSH 请新建会话。'
              : '这个会话已经是 DSH 对话，不能改成 Claude Code——两边的历史不共享。要用 Claude 请新建会话。')
          : (claude
              ? '本机 Claude Code 驱动这个会话；转录、工具卡片、审批都走 dsh 原生渲染。发出第一轮后就固定下来。'
              : 'DSH 原版循环。切换到 Claude Code 只在会话还没开始时可用。'),
        options: [
          { id: 'dsh', name: 'DSH', detail: '原版 harness 循环' },
          { id: 'claude', name: 'Claude Code', detail: '本机 claude CLI 驱动，dsh 只负责渲染' },
        ],
      })
    }

    function ClaudePostureSeat(props) {
      useStore()
      const sessionId = sessionIdOf(props)
      const state = stateOf(sessionId)
      React.useEffect(() => { load(sessionId) }, [sessionId])
      if (state.mode !== 'claude') return null

      function choose(next) {
        put(sessionId, Object.assign({}, state, { permissionMode: next }))
        host.call('permission.set', { sessionId: sessionId, permissionMode: next })
          .then((answer) => put(sessionId, answer))
          .catch((error) => console.error('cc-mode: switching permission mode failed:', error))
      }

      return h(Select, {
        value: state.permissionMode,
        onSelect: choose,
        align: 'left',
        label: '权限',
        title: 'Claude Code 的权限档，替代 dsh 的访问档（下一轮生效：用同一个 Claude 会话重启进程）',
        options: catalog.permissionModes || [],
      })
    }

    // Shadows dsh's own model seat while Claude drives.
    /** The catalog name for a raw route id like `claude-opus-5[1m]`. */
    function routeLabel(route, models) {
      if (typeof route !== 'string' || route.length === 0 || route === 'claude-code') return 'Claude 默认'
      const bare = route.replace(/\[[^\]]*\]$/, '')
      const hit = models.find((entry) => entry.id === bare)
      if (hit === undefined) return route
      return route.indexOf('[1m]') !== -1 ? hit.name + ' (1M)' : hit.name
    }

    function ClaudeModelSeat(props) {
      useStore()
      const sessionId = sessionIdOf(props)
      const state = stateOf(sessionId)
      const [open, setOpen] = React.useState(false)
      const [pane, setPane] = React.useState('root')
      const ref = useDismiss(open, () => { setOpen(false); setPane('root') })

      React.useEffect(() => { load(sessionId) }, [sessionId])

      const models = catalog.models || []
      const efforts = catalog.efforts || []
      const current = models.find((entry) => entry.id === state.model)
      // With no explicit choice the chip names the model the process actually
      // runs (from Claude's init handshake), not a vague "follow the default".
      const modelLabel = state.model.length > 0 && current
        ? current.name
        : routeLabel(state.route, models)
      const reasoning = current === undefined ? true : current.reasoning !== false
      const effortLabel = state.effort.length === 0 ? '默认' : state.effort

      function chooseModel(id) {
        put(sessionId, Object.assign({}, state, { model: id }))
        setOpen(false); setPane('root')
        host.call('model.set', { sessionId: sessionId, model: id })
          .then((answer) => put(sessionId, answer))
          .catch((error) => console.error('cc-mode: switching model failed:', error))
      }

      function chooseEffort(id) {
        put(sessionId, Object.assign({}, state, { effort: id }))
        setOpen(false); setPane('root')
        host.call('model.set', { sessionId: sessionId, effort: id })
          .then((answer) => put(sessionId, answer))
          .catch((error) => console.error('cc-mode: switching effort failed:', error))
      }

      function optionRow(option, selected, onSelect) {
        return h('button', {
          key: option.id,
          type: 'button',
          role: 'menuitem',
          className: SEL.option,
          onClick: () => onSelect(option.id),
        },
          h('span', { className: SEL.optionCopy },
            h('span', { className: SEL.modelName }, option.name),
            option.detail ? h('span', { className: SEL.description }, option.detail) : null),
          h('span', { className: SEL.check }, selected ? icon(CHECK, 16, undefined, 16) : null))
      }

      function cell(label, value, target) {
        return h('button', {
          type: 'button',
          role: 'menuitem',
          className: SEL.cell,
          onClick: () => setPane(target),
        },
          h('span', { className: SEL.cellLabel }, label),
          h('span', { className: SEL.cellValue }, value),
          icon(CHEVRON_RIGHT, 14, SEL.cellChevron, 14))
      }

      return h('div', { className: SEL.root, ref: ref },
        h('button', {
          type: 'button',
          className: SEL.trigger,
          title: 'Claude Code 的模型与 effort（模型热切换，effort 下一轮生效）',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => { setOpen(!open); setPane('root') },
        },
          CLAUDE_GLYPH,
          h('span', { className: SEL.triggerLabel }, modelLabel),
          reasoning ? h('span', { className: SEL.triggerEffort }, effortLabel) : null,
          h('span', { className: SEL.chevron + (open ? ' ' + SEL.chevronOpen : '') }, icon(CHEVRON_DOWN, 14, undefined, 14))),
        open ? h('div', { className: SEL.menu, role: 'menu' },
          pane === 'root'
            ? h(React.Fragment, null,
                cell('模型', modelLabel, 'model'),
                reasoning ? cell('Effort', effortLabel, 'effort') : null)
            : pane === 'model'
              ? h('div', { className: SEL.groups },
                  h('div', { className: SEL.group },
                    h('div', { className: SEL.groupTitle }, 'Claude Code'),
                    models.map((model) => optionRow(model, model.id === state.model, chooseModel))))
              : h('div', { className: SEL.groups },
                  h('div', { className: SEL.group },
                    h('div', { className: SEL.groupTitle }, 'Reasoning effort'),
                    efforts.map((effort) => optionRow(effort, effort.id === state.effort, chooseEffort))))) : null)
    }

    // ---------- Claude tool rows, in dsh's own card ----------

    function parseArgs(block) {
      const raw = 'kind' in block ? (block.call ? block.call.argsRaw : '') : block.argsRaw
      if (typeof raw !== 'string' || raw.length === 0) return {}
      try { return JSON.parse(raw) } catch (error) { return {} }
    }

    function outputText(block) {
      if (!('kind' in block)) return null
      const parts = []
      for (const part of block.content || []) {
        if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      }
      const text = parts.join('\n')
      return text.length === 0 ? null : text
    }

    function baseName(value) {
      if (typeof value !== 'string' || value.length === 0) return ''
      const parts = value.split('/')
      return parts[parts.length - 1] || value
    }

    /** Unwrap the product's own error envelope so the reason reads plainly. */
    function cleanError(text) {
      return String(text)
        .replace(/<\/?tool_use_error>/g, '')
        .replace(/^\s*Error:\s*/i, '')
        .trim()
    }

    function firstLine(value) {
      if (typeof value !== 'string') return ''
      const line = value.split('\n')[0]
      return line.length > 200 ? line.slice(0, 199) + '…' : line
    }

    // dsh titles a tool row with the tool's own name (its own rows read
    // "Bash", "Grep", "Glob"), so Claude's tools keep theirs. Only the summary
    // line is per-tool knowledge: which argument identifies the call.
    // Bash/Read/Write/Edit/Grep/Glob/WebFetch/WebSearch/TodoWrite/Skill are logged
    // under dsh's own tool names, so the deployment's existing rows render them —
    // including third-party ones such as dsh-better-tool-ui. What stays here is
    // the set of tools only Claude has.
    const TOOL_SUMMARY = {
      BashOutput: (a) => String(a.bash_id || a.shell_id || ''),
      KillShell: (a) => String(a.shell_id || ''),
      MultiEdit: (a) => baseName(a.file_path),
      NotebookEdit: (a) => baseName(a.notebook_path),
      NotebookRead: (a) => baseName(a.notebook_path),
      // This CLI spawns subagents as `Agent`; `Task` is the older name.
      Agent: (a) => String(a.description || a.subagent_type || ''),
      Task: (a) => String(a.description || a.subagent_type || ''),
      TaskOutput: (a) => String(a.task_id || a.agent_id || ''),
      TaskStop: (a) => String(a.task_id || a.agent_id || ''),
      SendMessage: (a) => String(a.to || ''),
      ToolSearch: (a) => String(a.query || ''),
      SlashCommand: (a) => String(a.command || ''),
      Workflow: (a) => firstLine(String(a.description || a.name || '')),
      Monitor: (a) => firstLine(String(a.command || '')),
      ScheduleWakeup: (a) => String(a.delaySeconds || '') + 's',
      AskUserQuestion: (a) => firstLine(String(a.question || '')),
      EnterWorktree: (a) => String(a.name || ''),
      ListAgents: () => '',
      ExitWorktree: () => '',
      ExitPlanMode: () => '',
    }


    function section(label, body, key) {
      return h('div', { key: key, className: CARD.ioSection },
        h('span', { className: CARD.ioLabel }, label),
        h('div', { className: CARD.ioText }, body))
    }

    function diffBody(before, after) {
      const rows = []
      String(before || '').split('\n').forEach((line, index) => {
        if (line.length > 0 || index > 0) rows.push(h('div', { key: 'b' + index, className: 'ccmode-diff-del' }, '- ' + line))
      })
      String(after || '').split('\n').forEach((line, index) => {
        if (line.length > 0 || index > 0) rows.push(h('div', { key: 'a' + index, className: 'ccmode-diff-add' }, '+ ' + line))
      })
      return rows
    }

    function todoBody(todos) {
      return h('ul', { className: 'ccmode-todo' },
        (todos || []).map((todo, index) => h('li', {
          key: index,
          className: todo.status === 'completed' ? 'done' : (todo.status === 'in_progress' ? 'active' : ''),
        }, (todo.status === 'completed' ? '✓ ' : (todo.status === 'in_progress' ? '▸ ' : '○ ')) + String(todo.content || ''))))
    }

    function ClaudeToolRow(props) {
      const [open, setOpen] = React.useState(false)
      const block = props.block
      const name = props.toolName || ''
      const summarize = TOOL_SUMMARY[name]
      const args = parseArgs(block)
      const settled = 'kind' in block
      const failed = settled && block.isError === true
      const output = outputText(block)
      const argsSummary = (summarize === undefined ? '' : summarize(args)) || ''
      // A failed row that only shows a red cross reads as "denied". Claude
      // refuses plenty of calls on its own terms ("File has not been read
      // yet", a hook, a guard) — say which, on the row itself.
      const failureLine = failed ? firstLine(cleanError(output || '')) : ''
      const summary = failed
        ? (argsSummary.length > 0 && failureLine.length > 0 ? argsSummary + ' · ' + failureLine : (failureLine || argsSummary))
        : argsSummary
      const state = !settled ? 'running' : (failed ? 'error' : 'ok')

      const parts = []
      if (name === 'Edit' && (args.old_string !== undefined || args.new_string !== undefined)) {
        parts.push(section('Diff', diffBody(args.old_string, args.new_string), 'diff'))
      } else if (name === 'MultiEdit' && Array.isArray(args.edits)) {
        args.edits.forEach((edit, index) => {
          parts.push(section('Diff ' + (index + 1), diffBody(edit.old_string, edit.new_string), 'diff' + index))
        })
      } else if (name === 'TodoWrite' && Array.isArray(args.todos)) {
        parts.push(section('Todos', todoBody(args.todos), 'todos'))
      } else if (name === 'Write' && typeof args.content === 'string') {
        parts.push(section('Content', args.content, 'content'))
      } else if (name === 'Bash' && typeof args.command === 'string') {
        parts.push(section('Command', args.command, 'command'))
      } else if (Object.keys(args).length > 0) {
        parts.push(section('Input', JSON.stringify(args, null, 2), 'input'))
      }
      if (output !== null) {
        if (parts.length > 0) parts.push(h('div', { key: 'divider', className: CARD.ioDivider }))
        parts.push(section(failed ? 'Error' : 'Output', output, 'output'))
      }
      const expandable = parts.length > 0

      function toggle() { if (expandable) setOpen(!open) }

      return h('div', { className: CARD.card },
        h('div', {
          className: CARD.root,
          'data-state': state,
          'data-expandable': expandable || undefined,
          role: expandable ? 'button' : undefined,
          tabIndex: expandable ? 0 : undefined,
          'aria-expanded': expandable ? open : undefined,
          onClick: toggle,
          onKeyDown: (event) => {
            if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
            event.preventDefault()
            toggle()
          },
        },
          h('span', { className: CARD.leading },
            open && expandable
              ? icon(CHEVRON_DOWN, 14, CARD.chevron, 14)
              : h(React.Fragment, null,
                  h('span', { className: expandable ? CARD.iconIdle : undefined },
                    failed ? '✗' : (settled ? '✓' : '·')),
                  expandable ? icon(CHEVRON_DOWN, 14, CARD.chevron + ' ' + CARD.chevronHover, 14) : null)),
          h('span', { className: CARD.title }, name),
          summary ? h('span', { className: CARD.sep }) : null,
          h('span', { className: CARD.summary + (failed ? ' ' + CARD.errorSummary : '') }, summary)),
        open && expandable
          ? h('div', { className: CARD.bodyWrap }, h('div', { className: CARD.ioCard }, parts))
          : null)
    }

    // ---------- pasted images (Claude conversations) ----------
    //
    // dsh's prompt RPC refuses images when the session's dsh model lacks
    // vision — a gate that knows nothing about the Claude engine. So in a
    // Claude conversation the paste is intercepted before dsh's attachment
    // flow sees it: the image is stashed on the host, a chip under the
    // composer shows what is waiting, and the next prompt carries the images
    // to Claude as native stream-json image blocks (and into the transcript
    // as dsh's own attachment blocks).
    // Called right after the composer submits, so the pending rail re-checks at
    // once instead of on its next tick.
    const submitWatchers = new Set()
    const BURST_MS = [0, 120, 300, 700, 1400]

    function noteComposerSubmit() {
      if (submitWatchers.size === 0) return
      for (const delay of BURST_MS) {
        window.setTimeout(() => { for (const pull of submitWatchers) pull() }, delay)
      }
    }

    const imageCounts = new Map()
    // Data URLs of what is waiting, so the rail shows the picture itself the
    // way dsh's own composer does — a line of text is not a preview.
    const imageThumbs = new Map()
    const imageWatchers = new Set()

    function setImageCount(sessionId, count) {
      imageCounts.set(sessionId, count)
      for (const notify of imageWatchers) notify()
    }

    // dsh's attachment store refuses an image over its per-side pixel limit
    // (2000px by default) or its byte limit, and a retina screenshot clears
    // both without trying. dsh's own composer only surfaces that as a toast, so
    // a pasted screenshot simply cannot be sent. Shrinking it here is the
    // difference between "cannot paste screenshots" and "screenshots work" —
    // and a smaller raster is what Claude wants anyway (it downscales past
    // ~1568px on the long edge regardless).
    let imageLimits = { maxImageBytes: 3670016, maxImageDimension: 2000, maxImagePixels: 40000000 }
    host.call('image.limits', {}).then((value) => {
      if (value !== null && value !== undefined) imageLimits = value
    }).catch(() => {})

    function decodeImage(url) {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('cc-mode: 这张图片解不开'))
        image.src = url
      })
    }

    /**
     * Return a data URL that dsh's store will accept: the original when it
     * already fits, otherwise the smallest faithful reduction that does.
     */
    function fitImage(url, mediaType) {
      const maxSide = Number(imageLimits.maxImageDimension) || 2000
      const maxBytes = Number(imageLimits.maxImageBytes) || 3670016
      const roughBytes = Math.floor((url.length - (url.indexOf(',') + 1)) * 3 / 4)
      return decodeImage(url).then((image) => {
        const side = Math.max(image.naturalWidth, image.naturalHeight)
        if (side <= maxSide && roughBytes <= maxBytes) return { url: url, mediaType: mediaType }
        // PNG screenshots re-encode badly under a byte budget; JPEG at a high
        // quality is both smaller and visually equivalent for this purpose.
        const encodeAs = roughBytes > maxBytes || mediaType === 'image/png' ? 'image/jpeg' : mediaType
        let scale = Math.min(1, maxSide / side)
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
          const context = canvas.getContext('2d')
          if (context === null) return { url: url, mediaType: mediaType }
          context.drawImage(image, 0, 0, canvas.width, canvas.height)
          const out = canvas.toDataURL(encodeAs, 0.9)
          const bytes = Math.floor((out.length - (out.indexOf(',') + 1)) * 3 / 4)
          if (bytes <= maxBytes) return { url: out, mediaType: encodeAs }
          scale *= 0.75
        }
        return { url: url, mediaType: mediaType }
      })
    }

    function handleImagePaste(event) {
      if (document.body.getAttribute('data-ccmode') !== 'claude') return
      const sessionId = currentClaudeSessionId
      if (sessionId.length === 0) return
      const target = event.target
      if (target === null || target === undefined || String(target.tagName).toLowerCase() !== 'textarea') return
      const items = event.clipboardData && event.clipboardData.items ? Array.from(event.clipboardData.items) : []
      const images = items.filter((item) => item.kind === 'file' && item.type.indexOf('image/') === 0)
      if (images.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      for (const item of images) {
        const file = item.getAsFile()
        if (file === null) continue
        const mediaType = file.type || 'image/png'
        const reader = new FileReader()
        reader.onload = () => {
          fitImage(String(reader.result), mediaType).then((fitted) => {
            const data = fitted.url.split(',')[1] || ''
            if (data.length === 0) return undefined
            return host.call('image.stash', { sessionId: sessionId, mediaType: fitted.mediaType, data: data })
              .then((answer) => {
                const thumbs = imageThumbs.get(sessionId) || []
                thumbs.push(fitted.url)
                imageThumbs.set(sessionId, thumbs)
                setImageCount(sessionId, (answer && answer.count) || 0)
              })
          }).catch((error) => console.error('cc-mode: 图片暂存失败:', error))
        }
        reader.readAsDataURL(file)
      }
    }

    // dsh's own composer rail, class for class (ui-attachment's
    // ComposerAttachments + AttachmentRail). Reusing the shipped names is what
    // makes the Claude rail sit in the same place, at the same size, in the
    // same theme as a dsh draft image — the seat below is the one the shipped
    // rail fills, so anything else here would read as a foreign widget.
    const DSH_RAIL = {
      outer: '_54WpYG_rail',
      root: 'JVDQca_root',
      rail: 'JVDQca_rail',
      item: 'JVDQca_item',
      thumb: 'JVDQca_thumbnail',
      remove: 'JVDQca_remove',
    }

    function closeGlyph() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 14 14', 'aria-hidden': 'true' },
        h('path', {
          fill: 'currentColor',
          d: 'M7 5.94 10.47 2.47a.75.75 0 1 1 1.06 1.06L8.06 7l3.47 3.47a.75.75 0 1 1-1.06 1.06L7 8.06l-3.47 3.47a.75.75 0 0 1-1.06-1.06L5.94 7 2.47 3.53a.75.75 0 0 1 1.06-1.06L7 5.94Z',
        }))
    }

    function railCard(key, url, alt, onRemove) {
      return h('div', { key: key, className: DSH_RAIL.item },
        h('button', { type: 'button', className: DSH_RAIL.thumb, title: alt },
          h('img', { src: url, alt: alt })),
        h('button', { type: 'button', className: DSH_RAIL.remove, 'aria-label': '移除', onClick: onRemove },
          closeGlyph()))
    }

    /**
     * The composer's draft-image rail while Claude drives. It fills dsh's own
     * `conversation.input.attachments` seat — the strip INSIDE the composer
     * card, above the text — rather than a band under it, because that is where
     * dsh shows a pasted image and where the user looks for it. dsh's own
     * drafts (a drag-and-drop that its gate did allow) still render here, so
     * taking the seat never hides anything.
     */
    function PendingImagesChip(props) {
      // The attachment seat is 'session-maybe' scoped, so it may arrive without
      // a sessionId; the engine chip records which conversation the composer
      // belongs to for exactly this case.
      const sessionId = String((props && props.sessionId) || currentClaudeSessionId || '')
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const notify = () => bump((n) => n + 1)
        imageWatchers.add(notify)
        return () => imageWatchers.delete(notify)
      }, [])

      const count = imageCounts.get(sessionId) || 0
      const state = stateOf(sessionId)
      const claude = state.mode === 'claude'

      // A started turn eats the stash on the host side. Nothing pushes that
      // back, so while images are pending the rail asks — otherwise it would
      // keep showing an image that has already been sent.
      React.useEffect(() => {
        if (!claude || sessionId.length === 0 || count === 0) return undefined
        const pull = () => {
          host.call('image.pending', { sessionId: sessionId })
            .then((answer) => {
              const now = (answer && answer.count) || 0
              if (now === count) return
              if (now === 0) imageThumbs.delete(sessionId)
              setImageCount(sessionId, now)
            })
            .catch(() => {})
        }
        const stop = ctx.interval(pull, 1500)
        // Polling alone made the rail linger a beat or two after the text had
        // already flown — the send itself is the moment to ask.
        submitWatchers.add(pull)
        return () => { stop(); submitWatchers.delete(pull) }
      }, [sessionId, claude, count])

      const drafts = (props && props.attachments) || []
      const thumbs = claude ? (imageThumbs.get(sessionId) || []) : []
      if (drafts.length === 0 && (!claude || count === 0)) return null

      // Per card, not per rail: the stash is an ordered list and the host drops
      // exactly the one this ✕ belongs to.
      const removeAt = (index) => host.call('image.remove', { sessionId: sessionId, index: index })
        .then((answer) => {
          const kept = (imageThumbs.get(sessionId) || []).slice()
          kept.splice(index, 1)
          if (kept.length === 0) imageThumbs.delete(sessionId)
          else imageThumbs.set(sessionId, kept)
          setImageCount(sessionId, (answer && answer.count) || 0)
        })
        .catch(() => {})

      const cards = drafts.map((draft, index) => railCard(
        'draft:' + (draft.id || index),
        draft.previewUrl,
        (draft.file && draft.file.name) || '待发送图片',
        () => { if (props && typeof props.onRemoveImage === 'function') props.onRemoveImage(draft.id) },
      ))
      for (let index = 0; index < Math.min(thumbs.length, count); index += 1) {
        cards.push(railCard('claude:' + index, thumbs[index], '待发送图片（Claude）',
          ((at) => () => removeAt(at))(index)))
      }

      // Stashed on the host but this tab never saw the bytes (another tab
      // pasted them, or the page reloaded): say so rather than draw nothing.
      if (claude && count > thumbs.length) {
        cards.push(h('div', { key: 'more', className: 'ccmode-rail-fallback' },
          '📷 另有 ' + (count - thumbs.length) + ' 张图片将随下一条消息发送'))
      }

      return h('div', { className: DSH_RAIL.outer },
        h('div', { className: DSH_RAIL.root },
          h('div', { className: DSH_RAIL.rail, role: 'group' }, cards)))
    }

    // ---------- Claude subscription usage, under the composer ----------

    // Same seat and the same compact readout shape dsh-balance uses, so the two
    // read as one row rather than two competing widgets.
    function pctClass(value) {
      if (value >= 90) return 'ccmode-pct-crit'
      if (value >= 70) return 'ccmode-pct-warn'
      return 'ccmode-pct-ok'
    }

    /** How long until this window resets, in the shortest readable form. */
    function resetIn(window) {
      if (!window.resetsAt) return ''
      const at = new Date(window.resetsAt)
      if (isNaN(at.getTime())) return ''
      const minutes = Math.floor((at.getTime() - Date.now()) / 60000)
      if (minutes <= 0) return 'now'
      if (minutes < 60) return minutes + 'm'
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return hours + 'h' + (minutes % 60 === 0 ? '' : (minutes % 60) + 'm')
      const days = Math.floor(hours / 24)
      return days + 'd' + (hours % 24 === 0 ? '' : (hours % 24) + 'h')
    }

    function resetAtText(window) {
      if (!window.resetsAt) return ''
      const at = new Date(window.resetsAt)
      if (isNaN(at.getTime())) return ''
      return at.toLocaleString()
    }

    function UsageReadout(props) {
      useStore()
      const sessionId = sessionIdOf(props)
      const state = stateOf(sessionId)
      const [usage, setUsage] = React.useState(null)
      const [, tick] = React.useState(0)
      const claude = state.mode === 'claude'

      React.useEffect(() => {
        if (!claude) return undefined
        let alive = true
        const pull = () => {
          host.call('usage', {}).then((value) => { if (alive) setUsage(value) }).catch(() => {})
        }
        pull()
        const stopPull = ctx.interval(pull, 60000)
        // The countdown has to move even when the numbers do not.
        const stopTick = ctx.interval(() => { if (alive) tick((n) => n + 1) }, 30000)
        return () => { alive = false; stopPull(); stopTick() }
      }, [claude])

      if (!claude) return null
      // Only an official subscription has windows to report; an API key or a
      // third-party gateway shows nothing at all rather than a wrong number.
      if (usage === null || usage.official !== true) return null
      if (usage.error !== undefined) {
        return h('span', { className: 'ccmode-usage ccmode-usage-error', title: String(usage.error) }, 'Claude usage unavailable')
      }
      const windows = usage.windows || []
      if (windows.length === 0) return null

      return h('span', {
        className: 'ccmode-usage',
        title: 'Claude ' + String(usage.subscription || '').toUpperCase() + ' — '
          + windows.map((w) => w.label + ' ' + Math.round(w.utilization) + '%'
            + (resetAtText(w) ? ' · resets ' + resetAtText(w) : '')).join('\n'),
      },
        h('span', { className: 'ccmode-usage-dot' }),
        h('span', { className: 'ccmode-usage-plan' }, 'Claude ' + String(usage.subscription || '').toUpperCase()),
        windows.map((window) => h('span', { key: window.id, className: 'ccmode-usage-item' },
          h('span', { className: 'ccmode-usage-label' }, window.label),
          h('span', { className: 'ccmode-usage-pct ' + pctClass(window.utilization) }, Math.round(window.utilization) + '%'),
          resetIn(window) ? h('span', { className: 'ccmode-usage-reset' }, '↻' + resetIn(window)) : null)),
        usage.extra ? h('span', { className: 'ccmode-usage-item' },
          h('span', { className: 'ccmode-usage-label' }, 'extra'),
          h('span', { className: 'ccmode-usage-pct ' + pctClass(usage.extra.utilization) }, Math.round(usage.extra.utilization) + '%')) : null)
    }

    // ---------- dsh's context panel, told the truth ----------
    //
    // The ring beside the send button is dsh's own and its reading is exact:
    // the host publishes the window, and the numerator is the usage Claude
    // reports. The COMPOSITION panel behind it is not — dsh derives those
    // three rows from its own session log, where a Claude conversation has no
    // `request/header` (that event is the session's model dispatch; writing
    // one bricks the composer) and where the surface is not what Claude
    // carries. So it drew "系统提示词 ~0 / 工具 ~0 / 对话消息 ~71.5K" under a
    // ring that correctly said 192K.
    //
    // The host asks Claude's own `/context` for the real composition; this
    // writes those figures into dsh's panel, in dsh's own nodes — same rows,
    // same labels, same swatches, same bar. Nothing is added and nothing is
    // hidden: only the three numbers and the bar's proportions change, so the
    // panel stays dsh's and simply stops disagreeing with its own total.
    // If dsh ever renders the panel differently, the shape check below fails
    // and the panel is left exactly as shipped.

    const breakdowns = new Map()
    let breakdownPending = ''

    /** dsh's own token formatting (StatsLine.formatTokens), digit for digit. */
    function formatTokens(value) {
      const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
      if (value < 1000) return String(value)
      if (value < 1000000) return scaled(value / 1000) + 'K'
      return scaled(value / 1000000) + 'M'
    }

    /**
     * dsh's open context panel, found by shape rather than by class: the
     * composer's only `[role="dialog"]` holding a definition list of exactly
     * three rows. Hashed CSS names change with every build; this does not.
     */
    function findContextPanel() {
      const dialogs = document.querySelectorAll('[role="dialog"]')
      for (let index = 0; index < dialogs.length; index += 1) {
        const dialog = dialogs[index]
        const list = dialog.querySelector('dl')
        if (list === null) continue
        const values = list.querySelectorAll('dd')
        if (values.length !== 3) continue
        return { dialog: dialog, list: list, values: values }
      }
      return undefined
    }

    /**
     * Write one session's real composition into the open panel.
     *
     * The bar is re-proportioned with the same rule dsh uses (each part takes
     * its share of the ring's exact percent), so the filled length still says
     * what the ring says — only the split between the three colors changes.
     */
    function paintContextPanel() {
      if (document.body.getAttribute('data-ccmode') !== 'claude') return
      const sessionId = currentClaudeSessionId
      if (sessionId.length === 0) return
      const panel = findContextPanel()
      if (panel === undefined) return

      // A composition moves with every turn, so a cached one is only good for
      // a short while: ask again behind whatever is already on screen, and
      // repaint when the newer answer lands.
      const report = breakdowns.get(sessionId)
      const stale = report === undefined || Date.now() - Number(report.fetchedAt || 0) > 15000
      if (stale && breakdownPending !== sessionId) {
        breakdownPending = sessionId
        host.call('context.breakdown', { sessionId: sessionId }).then((answer) => {
          breakdownPending = ''
          if (answer === null || answer === undefined || answer.known !== true) return
          answer.fetchedAt = Date.now()
          breakdowns.set(sessionId, answer)
          safelyClient('context panel', paintContextPanel)
        }).catch(() => { breakdownPending = '' })
      }
      if (report === undefined) return

      const parts = [report.systemTokens, report.toolsTokens, report.messageTokens]
      const total = parts[0] + parts[1] + parts[2]
      if (total <= 0) return

      // Idempotent by comparison rather than by a "done" flag: React re-renders
      // this panel whenever the projection moves, which puts dsh's own figures
      // back in nodes a flag would still call painted. Writing only what
      // differs also means the repaint tick costs nothing while it agrees, and
      // the redistribution below is stable — it preserves the filled length it
      // reads, so re-running it changes nothing.
      const wanted = parts.map((value) => '~' + formatTokens(value))
      let corrected = true
      for (let index = 0; index < 3; index += 1) {
        if (String(panel.values[index].textContent) === wanted[index]) continue
        panel.values[index].textContent = wanted[index]
        corrected = false
      }

      // The bar sits directly above the list; its segments are dsh's, and only
      // their widths are ours.
      const bar = panel.list.previousElementSibling
      if (bar === null || bar.children.length === 0) return
      // The ring's exact percent — the filled length must not change, only how
      // it splits. dsh drops a zero-width part, so on the very panel this fixes
      // (system 0, tools 0) the bar arrives with ONE segment holding the whole
      // length; summing whatever is there recovers the same number either way.
      let filled = 0
      for (let index = 0; index < bar.children.length; index += 1) {
        const width = parseFloat(String(bar.children[index].style.width))
        if (isFinite(width)) filled += width
      }
      if (filled <= 0) return

      const segments = barSegments(bar, panel.list)
      if (segments === undefined) return
      for (let index = 0; index < 3; index += 1) {
        const width = (filled * parts[index] / total) + '%'
        if (String(segments[index].style.width) === width) continue
        segments[index].style.width = width
        corrected = false
      }
      if (!corrected) {
        console.log('cc-mode: context panel now reads Claude\'s own /context —',
          wanted.join(' / '))
      }
    }

    /**
     * The bar's three segments, rebuilt when dsh dropped the parts it priced at
     * zero — which is exactly the case this whole correction exists for.
     *
     * Every class here is dsh's own, read off the panel rather than guessed: a
     * rebuilt segment is a clone of the one dsh rendered (so it keeps the
     * segment class and anything else the build put there), wearing the color
     * class its legend swatch carries. A swatch's color is the class it does
     * NOT share with the other two swatches.
     * @returns the three segments in row order, or undefined when the panel
     *   does not look the way this expects — in which case nothing is touched.
     */
    function barSegments(bar, list) {
      if (bar.children.length === 3) {
        return [bar.children[0], bar.children[1], bar.children[2]]
      }
      const swatches = list.querySelectorAll('dt span')
      if (swatches.length !== 3) return undefined
      const classSets = []
      for (let index = 0; index < 3; index += 1) {
        const names = String(swatches[index].className || '').split(/\s+/).filter((name) => name.length > 0)
        if (names.length === 0) return undefined
        classSets.push(names)
      }
      const colors = []
      for (let index = 0; index < 3; index += 1) {
        const others = classSets[(index + 1) % 3].concat(classSets[(index + 2) % 3])
        const own = classSets[index].filter((name) => others.indexOf(name) === -1)
        if (own.length !== 1) return undefined
        colors.push(own[0])
      }
      const template = bar.children[0]
      if (typeof template.cloneNode !== 'function') return undefined
      const rebuilt = []
      for (let index = 0; index < 3; index += 1) {
        const segment = template.cloneNode(false)
        const kept = String(template.className || '').split(/\s+/)
          .filter((name) => name.length > 0 && colors.indexOf(name) === -1)
        segment.className = kept.concat([colors[index]]).join(' ')
        rebuilt.push(segment)
      }
      while (bar.firstChild !== null && bar.firstChild !== undefined) bar.removeChild(bar.firstChild)
      for (const segment of rebuilt) bar.appendChild(segment)
      return rebuilt
    }

    /** A closed panel forgets its stamp, so the next open re-reads the figures. */
    function forgetContextPanel() {
      if (findContextPanel() === undefined) breakdownPending = ''
    }

    // ---------- Claude badge on the sidebar's session rows ----------
    //
    // The session list has no per-row slot and its rows carry no session id in
    // the DOM, so there is nothing official to register into. The badge is
    // therefore injected: rows are found by dsh's own row class, and each row's
    // session id is read off the React fiber the element already carries. Both
    // are private details of the shipped build — if either changes the badge
    // simply stops appearing, and nothing else breaks. Every badge is removed
    // when this package stops. The clean fix is a per-row slot upstream.
    const ROW_CLASS = 'YDXeBa_sessionRow'
    const TITLE_CLASS = 'YDXeBa_title'
    const BADGE_CLASS = 'ccmode-row-badge'

    /**
     * Read the session id a sidebar row renders.
     *
     * The row component is `SessionNodeItem({ node, currentId, … })`: `node`
     * describes THIS row, `currentId` is the selected session — reading the
     * latter would badge whatever row happens to be open. So the walk climbs to
     * the first fiber carrying a `node` prop and digs the id out of that.
     */
    const SESSION_ID_RE = /^session-[0-9a-zA-Z-]{8,}$/

    function findSessionId(value, depth) {
      if (depth > 3 || value === null || value === undefined) return undefined
      if (typeof value === 'string') return SESSION_ID_RE.test(value) ? value : undefined
      if (typeof value !== 'object') return undefined
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 8)) {
          const hit = findSessionId(item, depth + 1)
          if (hit !== undefined) return hit
        }
        return undefined
      }
      for (const key of Object.keys(value).slice(0, 24)) {
        const hit = findSessionId(value[key], depth + 1)
        if (hit !== undefined) return hit
      }
      return undefined
    }

    function sessionIdOfRow(element) {
      const fiberKey = Object.keys(element).find((key) => key.indexOf('__reactFiber$') === 0)
      let fiber = fiberKey === undefined ? undefined : element[fiberKey]
      for (let depth = 0; fiber !== null && fiber !== undefined && depth < 10; depth += 1) {
        const props = fiber.memoizedProps || fiber.pendingProps
        if (props !== null && props !== undefined && typeof props === 'object' && props.node !== undefined) {
          const hit = findSessionId(props.node, 0)
          if (hit !== undefined) return hit
        }
        fiber = fiber.return
      }
      return undefined
    }

    let engines = {}
    let badgeObserver = null

    function paintBadges() {
      const rows = document.getElementsByClassName(ROW_CLASS)
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]
        let sessionId
        try { sessionId = sessionIdOfRow(row) } catch (error) { sessionId = undefined }
        const wanted = sessionId !== undefined && engines[sessionId] === 'claude'
        const existing = row.getElementsByClassName(BADGE_CLASS)[0]
        if (wanted && existing === undefined) {
          const badge = document.createElement('span')
          badge.className = BADGE_CLASS
          badge.textContent = '✳'
          badge.title = 'Claude Code 驱动的对话'
          const title = row.getElementsByClassName(TITLE_CLASS)[0]
          if (title !== undefined) row.insertBefore(badge, title)
          else row.insertBefore(badge, row.firstChild)
        } else if (!wanted && existing !== undefined) {
          existing.remove()
        }
      }
    }

    function clearBadges() {
      const badges = document.getElementsByClassName(BADGE_CLASS)
      while (badges.length > 0) badges[0].remove()
    }

    function startBadges() {
      const pull = () => {
        host.call('engines', {}).then((answer) => {
          engines = (answer && answer.engines) || {}
          paintBadges()
        }).catch(() => {})
      }
      pull()
      const stopPull = ctx.interval(pull, 8000)
      // The list re-renders on selection, rename, new session — repaint with it.
      if (typeof MutationObserver === 'function') {
        badgeObserver = new MutationObserver(() => {
          paintBadges()
          safelyClient('menu item', injectImportItem)
          safelyClient('resume item', injectResumeItem)
          safelyClient('context panel', paintContextPanel)
          safelyClient('context panel', forgetContextPanel)
        })
        badgeObserver.observe(document.body, { childList: true, subtree: true })
      }
      document.addEventListener('click', noteWorkspaceClick, true)
      const stopMenuWatch = ctx.interval(() => {
        safelyClient('menu item', injectImportItem)
        safelyClient('resume item', injectResumeItem)
        // React re-renders the panel whenever the projection moves, which
        // restores dsh's own figures; repainting on the same beat as the menu
        // work keeps ours in place for as long as the panel is open.
        safelyClient('context panel', paintContextPanel)
      }, 300)
      return () => {
        stopMenuWatch()
        stopPull()
        document.removeEventListener('click', noteWorkspaceClick, true)
        if (badgeObserver !== null) { badgeObserver.disconnect(); badgeObserver = null }
        clearBadges()
      }
    }

    ctx.effect(() => startBadges(), 'cc-mode: sidebar Claude badges')

    // ---------- Claude's own command system ----------
    //
    // dsh's palette is fed by the host command registry plus client
    // contributions, and a contribution is always a popup. So Claude's slash
    // commands live behind one entry: `/claude` lists them (the list comes from
    // Claude's init handshake, cached by the host so a brand-new conversation
    // has it too) and picking one submits it to the session — our engine hands
    // it to the CLI verbatim, which is what runs it.
    const commandUi = ctx.get('commandUi')
    const sessions = ctx.get('sessions')

    // TEMPORARY probe: what did dsh's own assembler make of this session?
    try {
      window.__ccProbe = (sessionId) => {
        const binding = sessions.binding(sessionId)
        const face = binding && binding.session
        const snap = typeof face.get === 'function' ? face.get() : undefined
        const out = { hasGet: typeof face.get === 'function', snapType: Object.prototype.toString.call(snap) }
        if (snap !== undefined && snap !== null) {
          out.keys = Object.keys(snap).slice(0, 14)
          for (const key of Object.keys(snap)) {
            const value = snap[key]
            if (Array.isArray(value) && value.length > 0) {
              const blob = JSON.stringify(value)
              out[key] = {
                length: value.length,
                answer: blob.indexOf('这一轮的活儿已经全部完成') !== -1,
                notice: blob.indexOf('dsh 重启期间') !== -1,
                tail: value.slice(-4).map((n) => JSON.stringify(n).slice(0, 80)),
              }
            }
          }
        }
        return out
      }
    } catch (error) { /* probe only */ }

    function submitToSession(sessionId, text) {
      if (sessions === undefined) return Promise.resolve(false)
      let session
      try { session = sessions.binding(sessionId).session } catch (error) { session = undefined }
      if (session === undefined || typeof session.prompt !== 'function') return Promise.resolve(false)
      return session.prompt([{ type: 'text', text: text }], 'queue').then(() => true, () => false)
    }

    function isClaudeSession(sessionId) {
      const state = stateOf(String(sessionId))
      return state.mode === 'claude'
    }

    // dsh's own commands come from the host registry and cannot be removed by a
    // plugin, so "replace the palette with Claude's" is done the only way the
    // seam allows: every Claude command is registered as its own entry, and
    // `available` shows them only while that conversation runs on Claude —
    // switching back to DSH makes them disappear again.
    //
    // Collisions are the sharp edge here. ui-commands checks a contribution
    // against the HOST catalog not at registration but while synthesising
    // candidates, and it does not skip the row — it throws, which kills the
    // whole '/' source: dsh's own commands disappear from the menu along with
    // ours. So a name dsh already owns must never be offered bare. Two guards:
    // the name is registered as `<name>-claude` when the catalog says dsh has
    // it, and `available()` refuses any bare name found in that session's
    // catalog, so even an unseen collision hides one row instead of emptying
    // the menu.
    const registeredCommands = new Set()
    const hostCatalogs = new Map()
    // dsh's own host commands, as its packages register them (command-compact,
    // session-log-export, feedback, goal, permission-presets, plan-mode), plus
    // `model`, which ui-model-selection contributes. The live catalog below is
    // the authority; this set is what makes the FIRST registration safe, before
    // any catalog has been fetched.
    const knownHostNames = new Set(['compact', 'export', 'feedback', 'goal', 'permission', 'plan', 'model'])

    /** dsh's own command names for one session, as ui-commands itself reads them. */
    function loadHostCatalog(sessionId) {
      if (sessionId.length === 0) return Promise.resolve()
      if (hostCatalogs.has(sessionId)) return Promise.resolve()
      hostCatalogs.set(sessionId, new Set())
      let pending
      try { pending = ctx.remote.commands.list(sessionId) } catch (error) { pending = undefined }
      if (pending === undefined || typeof pending.then !== 'function') return Promise.resolve()
      return pending.then((result) => {
        const list = result && result.ok ? result.value : (Array.isArray(result) ? result : [])
        const names = new Set()
        for (const entry of list || []) {
          const name = entry && typeof entry.name === 'string' ? entry.name : ''
          if (name.length > 0) { names.add(name); knownHostNames.add(name) }
        }
        hostCatalogs.set(sessionId, names)
      }, () => { /* a session with no live agent has no catalog yet */ })
    }

    function hostOwns(sessionId, name) {
      const names = hostCatalogs.get(sessionId)
      if (names !== undefined && names.has(name)) return true
      return knownHostNames.has(name)
    }

    const oneShotCommands = new Set()

    function registerClaudeCommands(names) {
      if (commandUi === undefined) return
      for (const name of names) {
        if (registeredCommands.has(name)) continue
        registeredCommands.add(name)
        // Keep the prefix either way: `/goal` still finds a suffixed row, and
        // its description says whose it is.
        const collides = knownHostNames.has(name)
        const registerName = collides ? name + '-claude' : name
        const description = collides ? 'Claude Code · /' + name : 'Claude Code'
        try {
          commandDisposers.push(commandUi.register({
            name: registerName,
            description: description,
            available: (session) => {
              const sessionId = String(session && session.sessionId)
              loadHostCatalog(sessionId)
              if (!isClaudeSession(sessionId)) return false
              // Never offer a bare name this session's dsh catalog owns.
              return registerName !== name || !hostOwns(sessionId, name)
            },
            ui: {
              kind: 'popupSelect',
              options: async () => [
                {
                  id: 'run',
                  label: '/' + name,
                  detail: oneShotCommands.has(name) ? 'Claude Code · 直接执行并显示结果' : 'Claude Code 执行',
                },
              ],
              onSelect: async (option, session) => {
                // Claude's one-shot commands (`/mcp`, `/context`, `/usage`, …)
                // are panels in the terminal, not something the assistant says.
                // They run on the session's live process, out of band: no turn,
                // no transcript entry, and the answer opens in its own panel.
                if (oneShotCommands.has(name)) {
                  openCommandPanel(String(session.sessionId), cwdOf(session), '/' + name)
                  return
                }
                const ok = await submitToSession(session.sessionId, '/' + name)
                if (!ok) throw new Error('无法把命令发给这个会话')
              },
            },
          }))
        } catch (error) {
          // Another plugin already contributes this name (ui-model-selection
          // owns /model). One row is enough — drop ours rather than fight.
          registeredCommands.delete(name)
        }
      }
    }

    const commandDisposers = []
    ctx.effect(() => () => {
      for (const dispose of commandDisposers.splice(0)) {
        try { dispose() } catch (error) { /* already gone */ }
      }
    }, 'cc-mode: claude commands')

    function refreshClaudeCommands() {
      host.call('commands', {}).then((answer) => {
        for (const name of (answer && answer.oneShot) || []) oneShotCommands.add(String(name))
        registerClaudeCommands(((answer && answer.commands) || []).filter((name) => typeof name === 'string'))
      }).catch(() => {})
    }

    refreshClaudeCommands()

    if (commandUi !== undefined) {

      ctx.effect(() => commandUi.register({
        name: 'claude-import',
        description: '导入本机 Claude Code 的历史对话',
        available: (session) => {
          const state = stateOf(String(session && session.sessionId))
          return state.locked !== true
        },
        ui: {
          kind: 'popupSelect',
          options: async (session) => {
            const cwd = cwdOf(session)
            const answer = await host.call('claude.conversations', { cwd: cwd })
            const rows = (answer && answer.conversations) || []
            if (rows.length === 0) return [{ id: '', label: '这个目录下没有 Claude 对话', detail: cwd }]
            return rows.map((row) => ({
              id: row.claudeSessionId,
              label: row.title || row.claudeSessionId.slice(0, 8),
              detail: agoText(row.updatedAt) + ' · ' + Math.round(row.bytes / 1024) + 'KB · ' + (row.firstPrompt || '').slice(0, 40),
            }))
          },
          onSelect: async (option, session) => {
            if (option.id === '') return
            openImportPreview(String(session.sessionId), cwdOf(session), option.id)
          },
        },
      }), 'cc-mode: /claude-import command')
    }

    function cwdOf(session) {
      if (session === undefined || session === null) return ''
      if (typeof session.cwd === 'string') return session.cwd
      const snapshot = typeof session.getSnapshot === 'function' ? session.getSnapshot() : undefined
      return snapshot && typeof snapshot.cwd === 'string' ? snapshot.cwd : ''
    }

    function agoText(at) {
      const minutes = Math.max(0, Math.round((Date.now() - Number(at)) / 60000))
      if (minutes < 60) return minutes + ' 分钟前'
      const hours = Math.round(minutes / 60)
      return hours < 48 ? hours + ' 小时前' : Math.round(hours / 24) + ' 天前'
    }

    // ---------- the import preview ----------

    /**
     * The import panel is built as plain DOM rather than seated in a slot.
     *
     * Verified in a real browser: `shell.overlay` has no host in this
     * deployment (`[data-shell-overlay]` is absent), and the composer's own
     * overlay list is session-scoped, so neither mounts on the "new
     * conversation" screen where this entry is used. A self-owned element has
     * no such dependency, and it is removed on close and on teardown.
     */
    let importPanel = null

    function closeImportPanel() {
      if (importPanel === null) return
      importPanel.remove()
      importPanel = null
    }

    function el(tag, className, text) {
      const node = document.createElement(tag)
      if (className) node.className = className
      if (text !== undefined) node.textContent = text
      return node
    }

    /**
     * One of Claude's own one-shot commands, run on the live process and shown
     * the way the terminal shows it: its own panel, monospace, closable — not a
     * message the assistant "said", and not a turn the user has to wait out.
     */
    const MCP_STATUS = {
      connected: { mark: '✔', label: 'connected', className: 'ccmode-mcp-ok' },
      failed: { mark: '✕', label: 'failed', className: 'ccmode-mcp-bad' },
      pending: { mark: '·', label: 'pending', className: 'ccmode-mcp-wait' },
      needsAuth: { mark: '!', label: 'needs auth', className: 'ccmode-mcp-wait' },
    }

    /** The terminal's `/mcp` panel: servers grouped by where they are configured. */
    function mcpList(info) {
      const wrap = el('div', 'ccmode-mcp')
      const servers = info.mcpServers || []
      wrap.appendChild(el('div', 'ccmode-mcp-head', 'Manage MCP servers'))
      wrap.appendChild(el('div', 'ccmode-mcp-count', servers.length + ' servers'))
      const groups = [
        { scope: 'project', title: 'Local MCPs (' + (info.cwd || '') + ')' },
        { scope: 'user', title: 'User MCPs' },
        { scope: 'unknown', title: 'Other MCPs' },
      ]
      for (const group of groups) {
        const rows = servers.filter((server) => server.scope === group.scope)
        if (rows.length === 0) continue
        wrap.appendChild(el('div', 'ccmode-mcp-group', group.title))
        for (const server of rows) {
          const status = MCP_STATUS[server.status] || { mark: '·', label: server.status, className: 'ccmode-mcp-wait' }
          const row = el('div', 'ccmode-mcp-row')
          row.appendChild(el('span', 'ccmode-mcp-name', server.name))
          row.appendChild(el('span', 'ccmode-mcp-sep', '·'))
          row.appendChild(el('span', 'ccmode-mcp-status ' + status.className, status.mark + ' ' + status.label))
          wrap.appendChild(row)
        }
      }
      if (servers.length === 0) wrap.appendChild(el('div', 'ccmode-import-empty', '这个会话没有 MCP 服务器'))
      const foot = el('div', 'ccmode-mcp-foot',
        (info.model ? info.model + ' · ' : '') + info.toolCount + ' 个工具'
        + (info.version ? ' · Claude Code ' + info.version : ''))
      wrap.appendChild(foot)
      return wrap
    }

    function openCommandPanel(sessionId, cwd, command) {
      closeImportPanel()
      const scrim = el('div', 'ccmode-import-scrim')
      const panel = el('div', 'ccmode-import ccmode-command')
      const head = el('div', 'ccmode-import-head')
      head.appendChild(el('span', 'ccmode-import-title', command))
      head.appendChild(el('span', 'ccmode-import-sub', cwd.length > 0 ? 'Claude Code · ' + cwd : 'Claude Code'))
      const body = el('div', 'ccmode-import-body')
      const foot = el('div', 'ccmode-import-foot')
      const note = el('span', 'ccmode-import-note', '在这个会话的 Claude 进程上执行，不写进对话。')
      const close = el('button', 'ccmode-import-cancel', '关闭')
      close.addEventListener('click', closeImportPanel)
      foot.appendChild(note)
      foot.appendChild(close)
      panel.appendChild(head)
      panel.appendChild(body)
      panel.appendChild(foot)
      scrim.appendChild(panel)
      scrim.addEventListener('click', (event) => { if (event.target === scrim) closeImportPanel() })
      document.body.appendChild(scrim)
      importPanel = scrim

      body.appendChild(el('div', 'ccmode-import-empty', '执行中…'))

      // `/mcp` is the one command whose headless answer is a summary line while
      // the terminal draws a full server list. The data behind that list rides
      // in Claude's own handshake, so the panel draws it the same way.
      if (command === '/mcp') {
        host.call('claude.info', { sessionId: sessionId, cwd: cwd }).then((info) => {
          if (importPanel !== scrim) return
          if (info === null || info === undefined || info.known !== true) return
          body.textContent = ''
          body.appendChild(mcpList(info))
        }).catch((error) => { console.error('cc-mode: claude.info 失败:', error) })
      }

      // The host runs the command as a job and this polls it. `/compact` alone
      // spends tens of seconds to minutes inside the model, so the panel has to
      // stay honest about that instead of holding one request open and calling
      // the wait a failure.
      const fail = (reason) => {
        if (importPanel !== scrim) return
        body.textContent = ''
        body.appendChild(el('div', 'ccmode-import-empty', '执行失败：' + reason))
      }
      const settle = (answer) => {
        if (importPanel !== scrim) return
        const text = String((answer && answer.text) || '').trim()
        if (command === '/mcp' && body.getElementsByClassName('ccmode-mcp').length > 0) return
        body.textContent = ''
        if (text.length === 0) {
          body.appendChild(el('div', 'ccmode-import-empty', '这条命令没有输出'))
          return
        }
        const out = el('pre', 'ccmode-command-out', text)
        if (answer && answer.isError === true) out.className += ' ccmode-command-error'
        body.appendChild(out)
      }
      const waiting = (state) => {
        if (importPanel !== scrim) return
        if (command === '/mcp' && body.getElementsByClassName('ccmode-mcp').length > 0) return
        const seconds = Math.round((state.elapsedMs || 0) / 1000)
        const label = (state.status && state.status.length > 0 ? state.status : '执行中…')
          + (seconds > 2 ? ' ' + seconds + 's' : '')
        body.textContent = ''
        body.appendChild(el('div', 'ccmode-import-empty', label))
      }

      host.call('claude.command', { sessionId: sessionId, cwd: cwd, command: command }).then((answer) => {
        if (importPanel !== scrim) return
        if (answer && answer.busy === true) {
          body.textContent = ''
          body.appendChild(el('div', 'ccmode-import-empty', '这个会话正在跑一轮，等它结束再执行。'))
          return
        }
        const jobId = String((answer && answer.jobId) || '')
        if (jobId.length === 0) { settle(answer); return }
        const poll = () => {
          if (importPanel !== scrim) return
          host.call('claude.command.poll', { jobId: jobId }).then((state) => {
            if (importPanel !== scrim) return
            if (state === null || state === undefined || state.missing === true) {
              fail('这条命令的执行记录已经过期')
              return
            }
            if (state.done === true) { settle(state); return }
            waiting(state)
            window.setTimeout(poll, 1000)
          }).catch((error) => fail(String(error && error.message ? error.message : error)))
        }
        poll()
      }).catch((error) => fail(String(error && error.message ? error.message : error)))
    }

    function openImportPreview(sessionId, cwd, claudeSessionId, workspace) {
      closeImportPanel()
      const scrim = el('div', 'ccmode-import-scrim')
      const panel = el('div', 'ccmode-import')
      const head = el('div', 'ccmode-import-head')
      const titleRow = el('div', 'ccmode-import-titlerow')
      const back = el('button', 'ccmode-import-back', '←')
      back.type = 'button'
      back.title = '返回列表'
      back.style.display = 'none'
      titleRow.appendChild(back)
      titleRow.appendChild(el('span', 'ccmode-import-title', '导入 Claude Code 对话'))
      head.appendChild(titleRow)
      head.appendChild(el('span', 'ccmode-import-sub', cwd))
      const body = el('div', 'ccmode-import-body')
      const foot = el('div', 'ccmode-import-foot')
      const note = el('span', 'ccmode-import-note', '点一条对话看详情。')
      const cancel = el('button', 'ccmode-import-cancel', '取消')
      cancel.addEventListener('click', closeImportPanel)
      foot.appendChild(note)
      foot.appendChild(cancel)
      panel.appendChild(head)
      panel.appendChild(body)
      panel.appendChild(foot)
      scrim.appendChild(panel)
      scrim.addEventListener('click', (event) => { if (event.target === scrim) closeImportPanel() })
      document.body.appendChild(scrim)
      importPanel = scrim

      // Search: titles filter locally; transcript CONTENT is grepped by the
      // host, and a content-only match explains itself with a snippet.
      const search = el('input', 'ccmode-import-search')
      search.type = 'search'
      search.placeholder = '搜索标题或对话内容…'
      head.appendChild(search)

      let allRows = []
      let renderSeq = 0

      function renderRows(rows, snippets) {
        body.textContent = ''
        if (rows.length === 0) {
          body.appendChild(el('div', 'ccmode-import-empty',
            allRows.length === 0 ? '这个目录下没有 Claude Code 对话' : '没有匹配的对话'))
          return
        }
        for (const row of rows) {
          const item = el('button', 'ccmode-import-row')
          item.appendChild(el('span', 'ccmode-import-row-title', row.title || row.claudeSessionId.slice(0, 8)))
          item.appendChild(el('span', 'ccmode-import-row-meta',
            agoText(row.updatedAt) + ' · ' + Math.round(row.bytes / 1024) + 'KB'))
          const snippet = snippets !== undefined ? snippets.get(row.claudeSessionId) : undefined
          if (snippet !== undefined && snippet.length > 0) {
            item.appendChild(el('span', 'ccmode-import-row-hit', '…' + snippet + '…'))
          }
          if (Date.now() - row.updatedAt < 120000) {
            item.appendChild(el('span', 'ccmode-import-row-live',
              '⚠ 正在使用中 — 导入后续聊会形成分支，终端侧看不到 dsh 的消息'))
          }
          item.addEventListener('click', () => enterPreview(row))
          body.appendChild(item)
        }
      }

      function runSearch(query) {
        const seq = ++renderSeq
        const needle = query.trim().toLowerCase()
        if (needle.length === 0) { renderRows(allRows); return }
        const titleHits = allRows.filter((row) =>
          (row.title || '').toLowerCase().indexOf(needle) !== -1
          || (row.firstPrompt || '').toLowerCase().indexOf(needle) !== -1)
        renderRows(titleHits)
        host.call('claude.search', { cwd: cwd, query: query.trim() }).then((answer) => {
          if (importPanel !== scrim || seq !== renderSeq) return
          const snippets = new Map()
          for (const hit of (answer && answer.hits) || []) snippets.set(hit.claudeSessionId, hit.snippet || '')
          const seen = new Set(titleHits.map((row) => row.claudeSessionId))
          const contentHits = allRows.filter((row) => !seen.has(row.claudeSessionId) && snippets.has(row.claudeSessionId))
          renderRows(titleHits.concat(contentHits), snippets)
        }).catch(() => { /* title-only results already shown */ })
      }

      function enterPreview(row) {
        back.style.display = ''
        search.style.display = 'none'
        showPreview(scrim, body, foot, note, sessionId, cwd, row, workspace)
      }

      back.addEventListener('click', () => {
        back.style.display = 'none'
        search.style.display = ''
        const importButton = foot.querySelector('.ccmode-import-ok')
        if (importButton !== null) importButton.remove()
        note.textContent = '点一条对话看详情。'
        runSearch(search.value)
      })

      let searchTimer = null
      search.addEventListener('input', () => {
        if (searchTimer !== null) clearTimeout(searchTimer)
        searchTimer = setTimeout(() => runSearch(search.value), 300)
      })
      search.addEventListener('keydown', (event) => { if (event.key === 'Escape') { search.value = ''; renderRows(allRows) } })

      body.appendChild(el('div', 'ccmode-import-empty', '读取中…'))
      host.call('claude.conversations', { cwd: cwd }).then((answer) => {
        if (importPanel !== scrim) return
        allRows = (answer && answer.conversations) || []
        renderRows(allRows)
        search.focus()
      }).catch((error) => {
        if (importPanel !== scrim) return
        body.textContent = ''
        body.appendChild(el('div', 'ccmode-import-empty', '读取失败：' + String(error && error.message ? error.message : error)))
      })
    }

    function previewMessage(item) {
      // The same shape the conversation gives a message: the user's words in a
      // right-aligned bubble, the assistant's as plain flowing text.
      const line = el('div', 'ccmode-import-msg ' + item.role)
      line.appendChild(el('div', 'ccmode-import-bubble', item.text))
      return line
    }

    /**
     * A transcript's tool call, drawn with dsh's own tool-card chrome (the same
     * `CY-8Ka_*` classes a live row uses) rather than as a line of text. Plain
     * DOM because this panel owns its own DOM — but pixel-identical to a row in
     * the conversation above it, and expandable the same way.
     */
    function previewSection(label, text) {
      const wrap = el('div', CARD.ioSection)
      wrap.appendChild(el('span', CARD.ioLabel, label))
      wrap.appendChild(el('div', CARD.ioText, text))
      return wrap
    }

    function previewDiff(before, after) {
      const wrap = el('div', CARD.ioSection)
      wrap.appendChild(el('span', CARD.ioLabel, 'Diff'))
      const text = el('div', CARD.ioText)
      for (const removed of String(before || '').split('\n')) text.appendChild(el('div', 'ccmode-diff-del', '- ' + removed))
      for (const added of String(after || '').split('\n')) text.appendChild(el('div', 'ccmode-diff-add', '+ ' + added))
      wrap.appendChild(text)
      return wrap
    }

    // The live rows only need summaries for tools dsh has no view for; a
    // transcript preview draws every tool itself, so the common ones need their
    // own one-liners here — same shape dsh puts on the row.
    const PREVIEW_SUMMARY = {
      Bash: (a) => firstLine(String(a.command || '')),
      BashOutput: (a) => String(a.bash_id || a.shell_id || ''),
      Read: (a) => baseName(a.file_path || a.notebook_path),
      Write: (a) => baseName(a.file_path),
      Edit: (a) => baseName(a.file_path),
      Glob: (a) => String(a.pattern || ''),
      Grep: (a) => String(a.pattern || ''),
      WebFetch: (a) => String(a.url || ''),
      WebSearch: (a) => String(a.query || ''),
      TodoWrite: (a) => (Array.isArray(a.todos) ? a.todos.length + ' 项' : ''),
      Skill: (a) => String(a.skill || a.command || ''),
      Artifact: (a) => String(a.title || a.file_path || a.action || ''),
      ExitPlanMode: () => '',
    }

    function previewToolCard(item) {
      let args = {}
      try { args = JSON.parse(item.args || '{}') } catch (error) { args = {} }
      const name = String(item.name || 'tool')
      const summarize = PREVIEW_SUMMARY[name] || TOOL_SUMMARY[name]
      const failed = item.isError === true
      const argsSummary = (summarize === undefined ? '' : summarize(args)) || ''
      const failureLine = failed ? firstLine(cleanError(String(item.output || ''))) : ''
      const summary = failed
        ? (argsSummary.length > 0 && failureLine.length > 0 ? argsSummary + ' · ' + failureLine : (failureLine || argsSummary))
        : argsSummary

      const parts = []
      if (name === 'Edit' && (args.old_string !== undefined || args.new_string !== undefined)) {
        parts.push(previewDiff(args.old_string, args.new_string))
      } else if (name === 'MultiEdit' && Array.isArray(args.edits)) {
        for (const edit of args.edits) parts.push(previewDiff(edit.old_string, edit.new_string))
      } else if (name === 'Write' && typeof args.content === 'string') {
        parts.push(previewSection('Content', args.content))
      } else if (name === 'Bash' && typeof args.command === 'string') {
        parts.push(previewSection('Command', args.command))
      } else if (Object.keys(args).length > 0) {
        parts.push(previewSection('Input', JSON.stringify(args, null, 2)))
      }
      const output = String(item.output || '')
      if (output.length > 0) {
        if (parts.length > 0) parts.push(el('div', CARD.ioDivider))
        parts.push(previewSection(failed ? 'Error' : 'Output', output))
      }
      const expandable = parts.length > 0

      const card = el('div', 'ccmode-import-tool ' + CARD.card)
      const root = el('div', CARD.root)
      root.setAttribute('data-state', !item.settled ? 'running' : (failed ? 'error' : 'ok'))
      if (expandable) {
        root.setAttribute('data-expandable', 'true')
        root.setAttribute('role', 'button')
        root.setAttribute('tabindex', '0')
        root.setAttribute('aria-expanded', 'false')
      }
      const leading = el('span', CARD.leading)
      leading.appendChild(el('span', expandable ? CARD.iconIdle : '', failed ? '✗' : (item.settled ? '✓' : '·')))
      root.appendChild(leading)
      root.appendChild(el('span', CARD.title, name))
      if (summary.length > 0) {
        root.appendChild(el('span', CARD.sep))
        root.appendChild(el('span', CARD.summary + (failed ? ' ' + CARD.errorSummary : ''), summary))
      }
      card.appendChild(root)

      if (expandable) {
        const bodyWrap = el('div', CARD.bodyWrap)
        const ioCard = el('div', CARD.ioCard)
        for (const part of parts) ioCard.appendChild(part)
        bodyWrap.appendChild(ioCard)
        bodyWrap.style.display = 'none'
        card.appendChild(bodyWrap)
        root.addEventListener('click', () => {
          const open = bodyWrap.style.display === 'none'
          bodyWrap.style.display = open ? '' : 'none'
          root.setAttribute('aria-expanded', open ? 'true' : 'false')
        })
      }
      return card
    }

    function showPreview(scrim, body, foot, note, sessionId, cwd, row, workspace) {
      body.textContent = ''
      body.appendChild(el('div', 'ccmode-import-empty', '读取中…'))
      const active = Date.now() - row.updatedAt < 120000
      note.textContent = active
        ? '⚠ 这段对话可能正被终端使用：导入后 dsh 里的续聊会形成分支，终端 resume 看不到 dsh 侧的消息。'
        : '导入后，会在这个工作区新建会话并接着这段 Claude 对话继续。'
      let importButton = foot.querySelector('.ccmode-import-ok')
      if (importButton === null) {
        importButton = el('button', 'ccmode-import-ok', '导入这段对话')
        foot.appendChild(importButton)
      }
      importButton.disabled = false
      importButton.textContent = '导入这段对话'
      importButton.onclick = () => {
        importButton.disabled = true
        importButton.textContent = '⏳ 导入中…'
        Promise.resolve(adoptConversation(sessionId, cwd, row.claudeSessionId, workspace))
          .catch((error) => {
            if (importPanel !== scrim) return
            importButton.disabled = false
            importButton.textContent = '导入这段对话'
            note.textContent = '导入失败：' + String(error && error.message ? error.message : error)
          })
      }

      host.call('claude.preview', { cwd: cwd, claudeSessionId: row.claudeSessionId }).then((answer) => {
        if (importPanel !== scrim) return
        const messages = (answer && (answer.items || answer.messages)) || []
        body.textContent = ''
        if (messages.length === 0) {
          body.appendChild(el('div', 'ccmode-import-empty', '这段对话没有可预览的消息'))
          return
        }
        for (const item of messages) {
          body.appendChild(item.kind === 'tool' ? previewToolCard(item) : previewMessage(item))
        }
        body.scrollTop = body.scrollHeight
      }).catch(() => {})
    }

    function adoptConversation(sessionId, cwd, claudeSessionId, workspace) {
      const bind = (target) => host.call('claude.adopt', { sessionId: target, claudeSessionId: claudeSessionId, cwd: cwd })
        .then((answer) => {
          if (answer && answer.state) put(target, answer.state)
          if (sessions !== undefined && typeof sessions.open === 'function' && sessionId === null) {
            try { sessions.open(target) } catch (error) { console.error('cc-mode: could not open the imported conversation:', error) }
          }
          closeImportPanel()
        })
      if (sessionId !== null) {
        return bind(sessionId).catch((error) => {
          console.error('cc-mode: import failed:', error)
          throw error
        })
      }
      if (sessions === undefined || typeof sessions.create !== 'function') {
        return Promise.reject(new Error('cc-mode: cannot create a conversation to import into'))
      }
      const target = workspace !== null && workspace !== undefined && workspace.workspaceId
        ? { workspaceId: workspace.workspaceId }
        : { cwd: cwd }
      return sessions.create(target)
        .then((created) => bind(String(created)))
        .catch((error) => {
          console.error('cc-mode: import failed:', error)
          throw error
        })
    }

    // The workspace row's ⋯ menu has no slot (dsh renders it directly), so the
    // entry is injected: remember which workspace row was clicked, then keep one
    // item in the menu that opens right after. Verified against the running UI.
    const PROJECT_ROW_CLASS = 'YDXeBa_projectRow'
    const IMPORT_ITEM_CLASS = 'ccmode-menu-import'
    const RESUME_ITEM_CLASS = 'ccmode-menu-resume'
    let pendingWorkspace = null
    // Which Claude conversation's row opened the ⋯ menu that is about to appear.
    let pendingSession = null

    function safelyClient(label, fn) {
      try { return fn() } catch (error) { console.error('cc-mode: contained a failure in', label + ':', error) }
    }

    /**
     * The workspace a sidebar row stands for. dsh hands the row its workspace as
     * `props.group` — `{workspaceId, cwd, label, sessions}` — several fibers
     * above the DOM node, so rather than guessing the prop name this scans every
     * prop value for the shape that carries a workspace identity.
     */
    function findWorkspace(element) {
      const fiberKey = Object.keys(element).find((key) => key.indexOf('__reactFiber$') === 0)
      let fiber = fiberKey === undefined ? undefined : element[fiberKey]
      for (let depth = 0; fiber !== null && fiber !== undefined && depth < 14; depth += 1) {
        const props = fiber.memoizedProps || fiber.pendingProps
        if (props !== null && props !== undefined && typeof props === 'object') {
          for (const key of Object.keys(props)) {
            const value = props[key]
            if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
            const cwd = typeof value.cwd === 'string' ? value.cwd : (typeof value.path === 'string' ? value.path : '')
            const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId : ''
            if (cwd.length > 0 || workspaceId.length > 0) {
              return {
                path: cwd,
                workspaceId: workspaceId,
                title: typeof value.label === 'string' ? value.label : (typeof value.title === 'string' ? value.title : ''),
              }
            }
          }
        }
        fiber = fiber.return
      }
      return undefined
    }

    function noteWorkspaceClick(event) {
      safelyClient('workspace click', () => {
        let node = event.target
        for (let depth = 0; node !== null && node !== undefined && depth < 10; depth += 1) {
          const name = typeof node.className === 'string' ? node.className : ''
          // A conversation row: remember it only when this plugin owns it, so
          // the entry never shows up on a dsh conversation.
          if (name.indexOf(ROW_CLASS) >= 0) {
            let sessionId
            try { sessionId = sessionIdOfRow(node) } catch (error) { sessionId = undefined }
            pendingSession = sessionId !== undefined && engines[sessionId] === 'claude'
              ? { sessionId: sessionId, at: Date.now() }
              : null
            pendingWorkspace = null
            return
          }
          if (name.indexOf(PROJECT_ROW_CLASS) >= 0) {
            const found = findWorkspace(node)
            pendingWorkspace = found === undefined ? null : Object.assign({ at: Date.now() }, found)
            pendingSession = null
            return
          }
          node = node.parentElement
        }
      })
    }

    /** Put `text` on the clipboard, with the pre-permissions fallback. */
    function copyText(text) {
      if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text)
      }
      return new Promise((resolve, reject) => {
        try {
          const box = document.createElement('textarea')
          box.value = text
          box.style.position = 'fixed'
          box.style.opacity = '0'
          document.body.appendChild(box)
          box.select()
          document.execCommand('copy')
          box.remove()
          resolve()
        } catch (error) { reject(error) }
      })
    }

    /**
     * Build one entry in dsh's own ⋯ menu by cloning the first item it already
     * renders — dsh's Menu owns the markup, and copying it is what makes the
     * entry indistinguishable from the shipped ones.
     */
    function cloneMenuItem(menu, marker, label, glyph, onPick) {
      const items = menu.querySelectorAll('[role="menuitem"]')
      if (items.length === 0) return null
      const clone = items[0].cloneNode(true)
      clone.classList.add(marker)
      const labels = clone.querySelectorAll('span, div')
      let retexted = false
      for (let at = 0; at < labels.length; at += 1) {
        if (labels[at].children.length === 0 && String(labels[at].textContent).trim().length > 0) {
          labels[at].textContent = label
          retexted = true
          break
        }
      }
      if (!retexted) clone.textContent = label
      const svg = clone.querySelector('svg')
      if (svg !== null && svg.parentElement !== null) svg.parentElement.textContent = glyph
      clone.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onPick(clone)
      }, true)
      items[0].parentElement.insertBefore(clone, items[0])
      return clone
    }

    function closeOpenMenu() {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }

    function setItemLabel(item, text) {
      const labels = item.querySelectorAll('span, div')
      for (let at = 0; at < labels.length; at += 1) {
        if (labels[at].children.length === 0 && String(labels[at].textContent).trim().length > 0) {
          labels[at].textContent = text
          return
        }
      }
    }

    /**
     * "Copy the resume id" on a Claude conversation's ⋯ menu — the uuid that
     * goes after `claude --resume`, so the same conversation can be picked up
     * in a terminal.
     */
    function injectResumeItem() {
      const menus = document.querySelectorAll('[role="menu"]')
      if (menus.length === 0) { pendingSession = null; return }
      if (pendingSession === null) return
      for (let index = 0; index < menus.length; index += 1) {
        const menu = menus[index]
        if (menu.querySelector('.' + RESUME_ITEM_CLASS) !== null) continue
        const session = pendingSession
        cloneMenuItem(menu, RESUME_ITEM_CLASS, '复制 Claude 会话 UUID', '⧉', (item) => {
          host.call('state.get', { sessionId: session.sessionId }).then((state) => {
            const uuid = String((state && state.claudeSessionId) || '')
            if (uuid.length === 0) { setItemLabel(item, '这个对话还没有 Claude 会话 id'); return }
            return copyText(uuid).then(() => {
              setItemLabel(item, '已复制 ' + uuid.slice(0, 8) + '…')
              window.setTimeout(closeOpenMenu, 900)
            })
          }).catch((error) => {
            console.error('cc-mode: 复制会话 id 失败:', error)
            setItemLabel(item, '复制失败')
          })
        })
        return
      }
    }

    /**
     * Keep the entry in the menu for as long as the menu is open: dsh's Menu
     * measures itself and re-renders at its final position, and that
     * reconciliation drops any DOM node React does not know about.
     */
    function injectImportItem() {
      const menus = document.querySelectorAll('[role="menu"]')
      if (menus.length === 0) { pendingWorkspace = null; return }
      if (pendingWorkspace === null) return
      for (let index = 0; index < menus.length; index += 1) {
        const menu = menus[index]
        if (menu.querySelector('.' + IMPORT_ITEM_CLASS) !== null) continue
        const workspace = pendingWorkspace
        cloneMenuItem(menu, IMPORT_ITEM_CLASS, '导入 Claude Code 对话', '✳', () => {
          closeOpenMenu()
          openImportPreview(null, workspace.path, null, workspace)
        })
        return
      }
    }

    ctx.effect(() => () => closeImportPanel(), 'cc-mode: import panel')

    // ---------- seats ----------

    ctx.effect(() => {
      document.addEventListener('paste', handleImagePaste, true)
      return () => document.removeEventListener('paste', handleImagePaste, true)
    }, 'cc-mode: image paste interception')

    // Enter (or the send button) means the stash is about to change hands.
    ctx.effect(() => {
      const onKeyDown = (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return
        noteComposerSubmit()
      }
      const onClick = (event) => {
        const node = event.target
        if (node === null || node === undefined || typeof node.closest !== 'function') return
        if (node.closest('[data-composer-seat] button') === null) return
        noteComposerSubmit()
      }
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('click', onClick, true)
      return () => {
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('click', onClick, true)
      }
    }, 'cc-mode: pending images follow the send')

    slots.inject('conversation.input.left', () => slots.register(
      { name: 'conversation.input.left', id: 'ccmode-engine', order: -100 },
      EngineChip,
    ))

    slots.inject('tool.call.toolview', function* () {
      for (const name of Object.keys(TOOL_SUMMARY)) {
        yield slots.register({ name: 'tool.call.toolview', key: name }, ClaudeToolRow)
      }
    })

    ctx.effect(() => () => {
      for (const dispose of shadowDisposers.splice(0)) {
        try { dispose() } catch (error) { /* gone */ }
      }
      shadowHolders = 0
      document.body.removeAttribute('data-ccmode')
    }, 'cc-mode: release the shadowed seats')

    console.log('cc-mode: client v76 ready — native chrome, ' + Object.keys(TOOL_SUMMARY).length + ' tool rows')
  },
}
