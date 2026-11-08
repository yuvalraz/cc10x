import type { AgentSpawnArgs, On } from 'claude-code'
import { expect, test, type TestBody } from 'claude-code/testing'

import { BUILD_MID_PHASE, BUILD_REMEDIATION, FINISHED_BUILD, PLAN_AT_GAP1, TRIAGE_NEEDS_INFO, type LoopFixture } from './loop-fixtures'
import { parseEvents } from './loop-state'
import type { LoopView, Spawn } from '../types'

// 2026-10-18T12:51:24Z, the second the reviewer APPROVE line below carries.
const NOW = 1_792_327_884_000
const WF = 'wf-20261018T112922Z-7e99ef54'
const APPROVE =
  '{"ts": "2026-10-18T12:51:24Z", "wf": "' + WF + '", "event": "result_persisted", "phase": "build-review", "agent": "code-reviewer", "decision": "APPROVE", "details": {"phase_id": "P3"}}\n'

type Kit = Parameters<TestBody>[0]

const DIR = '/repo/.cc10x/workflows'

const bandProps = (hasSurvey = false) => ({
  hasSurvey,
  isWorking: true,
  maxRows: 3,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 3 },
  view: {},
})

// The disk beneath the plugin. `listing` 'missing': no .cc10x/workflows (fs.exists false, fs.list rejects);
// 'denied': the directory exists but fs.list rejects. `log` false leaves the newest artifact's events log
// unwritten; `older` lists more artifacts behind it, each a minute older, each with its log unless named in
// `noLog`. `denyRead` rejects every fs.read; `denyLog` rejects only events-log reads; `hold` answers ms to
// delay one fs.read by. `cwd` and `root` answer $.session.cwd() and $.session.root(); the workflows
// directory is /repo/.cc10x/workflows, plus each dir named in `extra` holding its one artifact and log;
// fs.exists and fs.list answer for those paths only. `denyCwd` rejects $.session.cwd(). Each dir in
// `refuseList` exists but fs.list rejects it. Tests change these fields between refreshes.
type Disk = {
  cwd: string
  root: string
  denyCwd: boolean
  refuseList: string[]
  extra: Record<string, LoopFixture>
  fixture: LoopFixture
  log: boolean
  older: LoopFixture[]
  noLog: string[]
  listing: 'files' | 'empty' | 'missing' | 'denied'
  denyRead: boolean
  denyLog: boolean
  hold: (path: string) => number
}

function answerFs(on: On, fixture: LoopFixture): Disk {
  const disk: Disk = {
    cwd: '/repo',
    root: '/repo',
    denyCwd: false,
    refuseList: [],
    extra: {},
    fixture,
    log: true,
    older: [],
    noLog: [],
    listing: 'files',
    denyRead: false,
    denyLog: false,
    hold: () => 0,
  }
  const eventsPath = (f: LoopFixture) => f.path.replace(/\.json$/, '.events.jsonl')
  const name = (p: string) => p.slice(p.lastIndexOf('/') + 1)
  const entry = (path: string, text: string, mtimeMs: number) =>
    ({ name: name(path), kind: 'file', size: text.length, mtimeMs, isLink: false }) as const
  on('session.root', () => ({ value: disk.root }))
  on('session.cwd', () => (disk.denyCwd ? { deny: 'EPERM: cwd refused' } : { value: disk.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.exists', (_, e) => ({ value: (disk.listing !== 'missing' && e.path === DIR) || e.path in disk.extra || disk.refuseList.includes(e.path) }))
  on('fs.list', (_, e) => {
    if (disk.refuseList.includes(e.path)) return { deny: 'EACCES: list refused' }
    const other = disk.extra[e.path]
    if (other) return { value: [entry(other.path, other.artifactText, NOW), entry(eventsPath(other), other.eventsText, NOW)] }
    if (disk.listing === 'missing' || e.path !== DIR) return { deny: 'ENOENT: no such directory' }
    if (disk.listing === 'denied') return { deny: 'EACCES: list refused' }
    if (disk.listing === 'empty') return { value: [] }
    const files = [entry(disk.fixture.path, disk.fixture.artifactText, NOW)]
    if (disk.log) files.push(entry(eventsPath(disk.fixture), disk.fixture.eventsText, NOW))
    disk.older.forEach((f, i) => {
      files.push(entry(f.path, f.artifactText, NOW - 60_000 * (i + 1)))
      if (!disk.noLog.includes(f.path)) files.push(entry(eventsPath(f), f.eventsText, NOW - 60_000 * (i + 1)))
    })
    return { value: files }
  })
  on('fs.read', async (_, e) => {
    if (disk.denyRead) return { deny: 'EACCES: read refused' }
    if (disk.denyLog && e.path.endsWith('.events.jsonl')) return { deny: 'EACCES: log refused' }
    const ms = disk.hold(e.path)
    if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms))
    const extra = Object.values(disk.extra)
    for (const f of [disk.fixture, ...disk.older, ...extra]) {
      const logged = f === disk.fixture ? disk.log : extra.includes(f) || !disk.noLog.includes(f.path)
      if (e.path === f.path) return { value: f.artifactText }
      if (e.path === eventsPath(f) && logged) return { value: f.eventsText }
    }
    return { deny: 'ENOENT: ' + e.path }
  })
  return disk
}

// What the plugin last wrote to its atoms: the test spies on `state.set` and lets the kit store it.
// `openedWrites` counts writes of the `opened` atom; `failOpened` refuses each such write. `expanded` is
// the last `expanded` write and `expandedWrites` counts them; `failExpanded` refuses each such write.
// `preLedger` stores each loop write without the fields P1 added, as an older plugin build stored it.
function watchState(on: On, failOpened = false, failExpanded = false, preLedger = false) {
  const seen: { loop?: LoopView; spawns?: Spawn[]; expanded?: Record<string, Record<string, boolean>>; openedWrites: number; expandedWrites: number } = {
    openedWrites: 0,
    expandedWrites: 0,
  }
  on('state.set', (_, e, next) => {
    const w = e as { plugin: string; key: string; value: unknown }
    if (w.plugin === 'cc10x' && w.key === 'opened') {
      seen.openedWrites++
      if (failOpened) return { deny: 'state store down' }
    }
    if (w.plugin === 'cc10x' && w.key === 'expanded') {
      seen.expandedWrites++
      if (failExpanded) return { deny: 'state store down' }
    }
    if (w.plugin === 'cc10x' && (w.key === 'loop' || w.key === 'spawns' || w.key === 'expanded')) Object.assign(seen, { [w.key]: w.value })
    if (preLedger && w.plugin === 'cc10x' && w.key === 'loop') {
      const { live, last } = w.value as LoopView
      const old = { live: live && { ...live, ledger: undefined }, last: last && { ...last, type: undefined, ledger: undefined } }
      return next({ ...e, value: { ...(w.value as LoopView), ...old } } as typeof e)
    }
    return next(e)
  })
  return seen
}

// The rest of the engine: every other call the hooks make, answered plainly.
// `refuse` names engine calls that answer `{ deny }` instead.
// 'agent.spawn!' makes the core spawn itself throw; 'ui.open' refuses every pane; 'opened' refuses every write of
// the `opened` atom and 'expanded' every write of the `expanded` atom; 'preLedger' stores loop writes as an older
// build did; 'agentId' makes the core spawn answer with no
// agentId. `opens` collects every pane id `ui.open` was asked for. The returned `views` and `toasts` collect each
// `ui.view` argument and toast text; set `viewDeny` to resolve `ui.view` with `{ deny }`, `viewReject` to reject it.
function engine(
  on: On,
  logs: string[] = [],
  refuse: ('command.register' | 'agent.spawn' | 'agent.spawn!' | 'ui.open' | 'opened' | 'expanded' | 'preLedger' | 'agentId')[] = [],
  opens: string[] = [],
) {
  on('command.register', () => (refuse.includes('command.register') ? { deny: 'refused' } : { value: { command: 'cc10x-loop' } }))
  on('ui.open', (_, e) => {
    opens.push(e.id)
    return refuse.includes('ui.open') ? { deny: 'surface refused' } : { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => {
    if (refuse.includes('agent.spawn!')) throw new Error('core spawn down')
    if (refuse.includes('agentId')) return { model: 'test' }
    return refuse.includes('agent.spawn') ? { deny: 'another plugin refused' } : { model: 'test', agentId: 'agent-1' }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const views: { agentId?: string }[] = []
  const toasts: string[] = []
  const kit = Object.assign(watchState(on, refuse.includes('opened'), refuse.includes('expanded'), refuse.includes('preLedger')), { views, toasts, viewDeny: '', viewReject: '' })
  on('ui.view', (_, e) => {
    views.push(e)
    return kit.viewReject ? { deny: kit.viewReject } : { value: kit.viewDeny ? { deny: kit.viewDeny } : {} }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return kit
}

// `isFullscreen` is what the surface says of docking a pane (absent: it has not said).
const band = async ($: Kit, surface: 'terminal' | 'desktop' = 'terminal', hasSurvey = false, isFullscreen?: boolean) => {
  const viewport = isFullscreen === undefined ? undefined : { columns: 160, rows: 40, isFullscreen }
  const ui = await $.ui.mount({ plugin: 'cc10x', component: 'AbovePrompt', surface, props: bandProps(hasSurvey), viewport })
  const text = (await ui.find({ type: 'Text', text: /./ }))?.text
  await ui.unmount()
  return text
}

const start = ($: Kit) =>
  $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

// The engine fills `provider` with the plugin id (`name@marketplace`); the test kit passes it through as given.
const fromCc10x = (subagentType: string, provider = 'cc10x@cc10x') =>
  ({ prompt: 'run', description: subagentType, subagentType, provider: { plugin: provider, tier: 'user' } }) as AgentSpawnArgs
const reviewer = fromCc10x('cc10x:code-reviewer')
const hunter = fromCc10x('cc10x:failure-hunter')
const turnDone = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
const line = (event: string, phase: string, agent: string, decision: string) =>
  JSON.stringify({ ts: '2026-10-18T12:51:24Z', wf: WF, event, phase, agent, decision, details: { phase_id: 'P3' } }) + '\n'
const rows = (view: LoopView | undefined) =>
  Object.fromEntries((view?.live?.steps ?? []).map(s => [s.agent + '/' + s.phase, s.status]))

test('/cc10x-loop opens the pane and says so', async ($, on) => {
  // Nothing sits beneath the plugin: each hook here stands for the engine.
  const opens: string[] = []
  on('command.register', () => ({ value: { command: 'cc10x-loop' } }))
  on('ui.open', (_, e) => {
    opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'cc10x-loop', args: '' })

  expect(opens).toEqual(['cc10x-loop'])
  expect(ran.text).toBe('cc10x loop pane opened.')
})

test('/cc10x-loop reports a pane the surface could not place', async ($, on) => {
  on('command.register', () => ({ value: { command: 'cc10x-loop' } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'too narrow' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'cc10x-loop', args: '' })

  expect(ran.text).toBe('cc10x loop pane waiting: too narrow')
})

test('/cc10x-loop answers with the reason when the pane does not open', async ($, on) => {
  on('command.register', () => ({ value: { command: 'cc10x-loop' } }))
  on('ui.open', () => ({ deny: 'surface refused' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'cc10x-loop', args: '' })

  expect(ran.text).toContain('did not open')
  expect(ran.text).toContain('surface refused')
})

test('a refused command.register is logged, not swallowed', async ($, on) => {
  const logs: string[] = []
  on('command.register', () => ({ deny: 'refused' }))
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(logs.some(line => line.includes('command.register failed'))).toBe(true)
  expect(logs.some(line => line.includes('refused'))).toBe(true)
})

test('band 1/6. the band names the live BUILD phase, on terminal and desktop', async ($, on) => {
  engine(on)
  answerFs(on, BUILD_MID_PHASE)
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await band($, surface)).toMatch(/^cc10x BUILD P3\/7 · next: code-reviewer/)
    expect(await band($, surface)).not.toMatch(/stale/)
  }
})

test('band 2/3/7. a reviewer spawn runs; the APPROVE line after it moves next on', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  await $.agent.spawn(reviewer)

  expect(await band($)).toMatch(/code-reviewer running 0m00s/)
  expect(state.spawns).toEqual([
    { agent: 'code-reviewer', atIndex: parseEvents(BUILD_MID_PHASE.eventsText).length, startedAt: NOW, phaseId: 'P3', wf: WF, agentId: 'agent-1' },
  ])

  // The router appends the reviewer's result with a Bash call; that call refreshes the loop.
  disk.fixture = { ...BUILD_MID_PHASE, eventsText: BUILD_MID_PHASE.eventsText + APPROVE }
  await $.tool.call({ tool: 'Bash', command: "printf '...' >> .cc10x/workflows/" + WF + '.events.jsonl' })

  const after = await band($)
  expect(after).toMatch(/next: /)
  expect(after).not.toMatch(/code-reviewer running/)
})

test('band 2b. a call that does not touch .cc10x/workflows/ does not refresh; turn.complete does', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  disk.listing = 'empty'

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await band($)).toMatch(/^cc10x BUILD/)

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await band($)).toBe('engine')
})

test('band spawn. a spawn outside any chain or before a live workflow never binds', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.listing = 'missing'
  await start($)
  await $.agent.spawn(reviewer)
  await $.agent.spawn({ prompt: 'x', subagentType: 'general-purpose' })

  expect(state.spawns).toEqual([{ agent: 'code-reviewer', atIndex: 0, startedAt: NOW, phaseId: 'N/A', wf: '', agentId: 'agent-1' }])
})

test('ledger spawn. a core spawn result with no agentId records no agentId key', async ($, on) => {
  const state = engine(on, [], ['agentId'])
  answerFs(on, BUILD_MID_PHASE)
  await start($)
  await $.agent.spawn(reviewer)

  expect(state.spawns).toHaveLength(1)
  expect('agentId' in state.spawns![0]).toBe(false)
})

test('ledger resume. a resumed agent is recorded again under its resume agentId, so its second result binds agent-1', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  await $.agent.spawn(reviewer)
  disk.fixture = { ...BUILD_MID_PHASE, eventsText: BUILD_MID_PHASE.eventsText + APPROVE }
  await $.turn.complete(turnDone)
  await $.agent.spawn({ ...reviewer, resume: { agentId: 'agent-1' } })
  expect(await band($)).toMatch(/code-reviewer running/)
  disk.fixture = { ...BUILD_MID_PHASE, eventsText: BUILD_MID_PHASE.eventsText + APPROVE + APPROVE }
  await $.turn.complete(turnDone)

  expect(state.spawns?.map(s => s.agentId)).toEqual(['agent-1', 'agent-1'])
  const runs = state.loop?.live?.ledger[2].steps.filter(s => s.agent === 'code-reviewer')
  expect(runs?.map(s => [s.kind, s.agentId])).toEqual([['run', 'agent-1'], ['run', 'agent-1']])
})

test('ledger last. a finished workflow\'s view.last carries type BUILD and its seven-row ledger', async ($, on) => {
  const state = engine(on)
  answerFs(on, FINISHED_BUILD)
  await start($)

  const last = state.loop?.last
  expect(last?.type).toBe('BUILD')
  expect(last?.ledger.map(p => p.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'])
  expect(last?.ledger[6].steps.map(s => s.decision)).toEqual(['COMMITTED', 'DONE'])
})

test('band wf. a spawn recorded against workflow A does not run a row of workflow B', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  await $.agent.spawn(reviewer)
  expect(await band($)).toMatch(/code-reviewer running/)

  // Workflow B: the same artifact and log under another id (same cursor, same indices).
  const other = (text: string) => text.split('7e99ef54').join('0000beef')
  disk.fixture = {
    path: other(BUILD_MID_PHASE.path),
    artifactText: other(BUILD_MID_PHASE.artifactText),
    eventsText: other(BUILD_MID_PHASE.eventsText),
  }
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const b = await band($)
  expect(b).toMatch(/^cc10x BUILD P3\/7 · next: code-reviewer/)
  expect(b).not.toMatch(/running/)
})

test('band 4. no workflow files: the band yields', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.listing = 'empty'
  await start($)

  expect(await band($)).toBe('engine')
})

test('band 4b. no .cc10x/workflows directory is the idle state, not an error', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.listing = 'missing'
  await start($)

  expect(await band($)).toBe('engine')
  expect(state.loop).toEqual({ live: null, last: null, error: null })
})

test('band 4c. a read failure keeps the previous live workflow and records the error', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  disk.denyRead = true
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const view = state.loop!
  expect(view.live?.wf).toBe(WF)
  expect(view.error).toContain('EACCES: read refused')
  expect(await band($)).toMatch(/^cc10x BUILD P3\/7.* · stale$/)
})

test('band 4d. an artifact that is not a JSON object is an error, never passed on', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)

  for (const artifactText of ['null', '[1]', '{"workflow_uuid": ']) {
    disk.fixture = { ...BUILD_MID_PHASE, artifactText }
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    const view = state.loop!
    expect(view.live?.wf).toBe(WF)
    expect(view.error).not.toBe(null)
  }
})

test('band 4e. a workflow_type naming an Object.prototype key draws with a warning, no throw', async ($, on) => {
  const logs: string[] = []
  const state = engine(on, logs)
  answerFs(on, { ...BUILD_MID_PHASE, artifactText: BUILD_MID_PHASE.artifactText.replace('"workflow_type": "BUILD"', '"workflow_type": "constructor"') })
  await start($)

  const view = state.loop!
  expect(view.error).toBe(null)
  expect(view.live?.warnings).toContain('unknown workflow type: constructor')
  expect(await band($)).toMatch(/^cc10x constructor P3\/7/)
  expect(logs).toEqual([])
})

test('band 4f. a finished workflow is no live band: the band yields and last names it', async ($, on) => {
  const state = engine(on)
  answerFs(on, FINISHED_BUILD)
  await start($)

  const view = state.loop!
  expect(view.live).toBe(null)
  expect(view.last?.wf).toBe(WF)
  expect(view.last?.finishedAt).toMatch(/^2026-10-/)
  expect(await band($)).toBe('engine')
})

test('band 5. a survey above the prompt: the band yields', async ($, on) => {
  engine(on)
  answerFs(on, BUILD_MID_PHASE)
  await start($)

  expect(await band($, 'terminal', true)).toBe('engine')
})

test('fix 1. parallel reviewer and hunter spawns: a slower, older scan never overwrites the newer view', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  // The hunter's first read is a little slow, so the reviewer's re-read starts with only the reviewer
  // recorded; that re-read is slower still and ends after the hunter's re-read saw both spawns.
  let reads = 0
  let held = false
  disk.hold = path => {
    if (path !== BUILD_MID_PHASE.path) return 0
    reads += 1
    if (reads === 2) return 20
    if (held || state.spawns?.length !== 1) return 0
    held = true
    return 60
  }
  await Promise.all([$.agent.spawn(reviewer), $.agent.spawn(hunter)])
  await new Promise(resolve => setTimeout(resolve, 100))

  expect(held).toBe(true)
  expect(rows(state.loop)).toMatchObject({ 'code-reviewer/build-review': 'running', 'failure-hunter/build-hunt': 'running' })
})

test('fix 2a. an artifact listed before its events log is live, with no error', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.log = false
  await start($)

  expect(state.loop?.error).toBe(null)
  expect(state.loop?.live?.wf).toBe(WF)
  expect(state.loop?.live?.events).toEqual([])
})

const otherWf = (f: LoopFixture): LoopFixture => {
  const other = (text: string) => text.split('7e99ef54').join('0000beef')
  return { path: other(f.path), artifactText: other(f.artifactText), eventsText: other(f.eventsText) }
}

test('fix 2b. a corrupt older artifact behind a finished newer one: last set, error recorded, band yields', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, FINISHED_BUILD)
  disk.older = [{ ...otherWf(BUILD_MID_PHASE), artifactText: '{"workflow_uuid": ' }]
  await start($)

  expect(state.loop?.live).toBe(null)
  expect(state.loop?.last?.wf).toBe(WF)
  expect(state.loop?.error).toContain('wf-20261018T112922Z-0000beef.json')
  expect(await band($)).toBe('engine')
})

test('fix 2c. an orphan artifact (no log) behind a live workflow that just finished: the band yields', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  const orphan = otherWf(BUILD_MID_PHASE)
  disk.older = [orphan]
  disk.noLog = [orphan.path]
  await start($)
  expect(await band($)).toMatch(/^cc10x BUILD P3\/7/)

  disk.fixture = FINISHED_BUILD
  await $.turn.complete(turnDone)

  expect(state.loop?.live).toBe(null)
  expect(state.loop?.last?.wf).toBe(WF)
  expect(await band($)).toBe('engine')
})

test('fix 3. fs.list refused on an existing directory is an error, not idle', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  disk.listing = 'denied'
  await $.turn.complete(turnDone)

  expect(state.loop?.live?.wf).toBe(WF)
  expect(state.loop?.error).toContain('EACCES: list refused')
})

test('fix 4. a bare code-reviewer from another provider is not recorded', async ($, on) => {
  const state = engine(on)
  answerFs(on, BUILD_MID_PHASE)
  await start($)
  await $.agent.spawn(fromCc10x('code-reviewer', 'my-project'))

  expect(state.spawns).toBe(undefined)
})

test('fix 5. a boundary appended by an unfiltered call, then a spawn: the row runs', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  disk.fixture = { ...BUILD_MID_PHASE, eventsText: BUILD_MID_PHASE.eventsText + line('phase_started', 'build', 'router', 'start') }
  await $.tool.call({ tool: 'Bash', command: 'printf "$LINE" >> "$LOG"' })
  await $.agent.spawn(reviewer)

  expect(rows(state.loop)['code-reviewer/build-review']).toBe('running')
})

test('fix 6. a refused command.register still reads the loop at session start', async ($, on) => {
  const logs: string[] = []
  engine(on, logs, ['command.register'])
  answerFs(on, BUILD_MID_PHASE)
  await start($)

  expect(logs.some(l => l.includes('command.register failed') && l.includes('refused'))).toBe(true)
  expect(await band($)).toMatch(/^cc10x BUILD P3\/7/)
})

test('fix 7. a spawn another plugin refused is not recorded', async ($, on) => {
  const state = engine(on, [], ['agent.spawn'])
  answerFs(on, BUILD_MID_PHASE)
  await start($)
  await $.agent.spawn(reviewer)

  expect(state.spawns).toBe(undefined)
})

test('wave 8 / 1. a cc10x agent loaded with --plugin-dir (provider cc10x@inline) is recorded', async ($, on) => {
  const state = engine(on)
  answerFs(on, BUILD_MID_PHASE)
  await start($)
  await $.agent.spawn(fromCc10x('cc10x:code-reviewer', 'cc10x@inline'))

  expect(state.spawns?.map(s => s.agent)).toEqual(['code-reviewer'])
})

test('wave 8 / 2. parallel spawns after an unfiltered boundary: each records from its own read, both rows run', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  disk.fixture = { ...BUILD_MID_PHASE, eventsText: BUILD_MID_PHASE.eventsText + line('phase_started', 'build', 'router', 'start') }
  await $.tool.call({ tool: 'Bash', command: 'printf "$LINE" >> "$LOG"' })
  // Artifact reads from here: 1 the reviewer's first scan (fast, superseded by 2, so it never writes);
  // 2 the hunter's first scan (slow, superseded by 3); 3 the reviewer's re-read (slower, superseded by 4);
  // 4 the hunter's re-read writes. Neither first scan's view reaches the atom before its spawn records.
  let reads = 0
  disk.hold = path => {
    if (path !== BUILD_MID_PHASE.path) return 0
    reads += 1
    return reads === 2 ? 30 : reads === 3 ? 60 : 0
  }
  await Promise.all([$.agent.spawn(reviewer), $.agent.spawn(hunter)])

  expect(reads).toBe(4)
  expect(rows(state.loop)).toMatchObject({ 'code-reviewer/build-review': 'running', 'failure-hunter/build-hunt': 'running' })
})

test('wave 8 / 4. a core spawn that throws is logged as a spawn failure, not a record failure', async ($, on) => {
  const logs: string[] = []
  engine(on, logs, ['agent.spawn!'])
  answerFs(on, BUILD_MID_PHASE)
  await start($)
  await $.agent.spawn(reviewer).catch(() => undefined)

  expect(logs.some(l => l.startsWith('cc10x: spawn failed'))).toBe(true)
  expect(logs.some(l => l.includes('spawn record failed'))).toBe(false)
})

// ---- P4: the pane and the command ----

const paneProps = {
  title: 'cc10x loop',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

type Surface = 'terminal' | 'desktop' | 'vscode'

// Every Text the pane drew, in order, with whether it is dim.
const pane = async ($: Kit, surface: Surface = 'terminal') => {
  const ui = await $.ui.mount({ plugin: 'cc10x', component: 'Pane', requestId: 'cc10x-loop', surface, props: paneProps })
  const found = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return found.map(t => ({ text: t.text, dim: t.props.dimColor === true }))
}
const texts = async ($: Kit, surface: Surface = 'terminal') => (await pane($, surface)).map(t => t.text)
const SURFACES = ['terminal', 'desktop', 'vscode'] as const
const REM_WF = 'wf-20261018T112922Z-7e99ef54'

// The pane as drawn under `view` (the site's view in force): its Buttons, and its Texts as `pane()` reads them.
const ledger = async ($: Kit, view: { agentId?: string } = {}, surface: Surface = 'terminal') => {
  const ui = await $.ui.mount({ plugin: 'cc10x', component: 'Pane', requestId: 'cc10x-loop', surface, props: { ...paneProps, view } })
  const buttons = (await ui.findAll({ type: 'Button' })).map(b => ({ key: b.key, label: b.props.label }))
  const found = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return { buttons, texts: found.map(t => ({ text: t.text, dim: t.props.dimColor === true })) }
}
// Presses the pane Button keyed `key` once, on a fresh mount; read the result by mounting again.
const press = async ($: Kit, key: string, view: { agentId?: string } = {}) => {
  const ui = await $.ui.mount({ plugin: 'cc10x', component: 'Pane', requestId: 'cc10x-loop', surface: 'terminal', props: { ...paneProps, view } })
  await ui.press({ key })
  await ui.unmount()
}
const closed = (id: string, status: string, fixes = 0) => ({ key: 'phase:' + id, label: `▸ ${id} ${status} · ${fixes} ${fixes === 1 ? 'fix' : 'fixes'}` })
const MID_HEADER = 'cc10x · BUILD ' + WF + ' · /repo/loop-pane-fixture.md'

test('ledger pane 1. BUILD_MID_PHASE on every surface: phase Buttons, P3 open with the builder run and the spawned reviewer running, the remediation footer', async ($, on) => {
  engine(on)
  answerFs(on, BUILD_MID_PHASE)
  await start($)
  await $.agent.spawn(reviewer)

  for (const surface of SURFACES) {
    const { buttons, texts } = await ledger($, {}, surface)
    expect(buttons).toEqual([
      closed('P1', 'completed', 3),
      closed('P2', 'completed'),
      { key: 'phase:P3', label: '▾ P3 running · 0 fixes' },
      { key: 'running:code-reviewer', label: 'code-reviewer running 0m00s' },
      closed('P4', 'pending'),
      closed('P5', 'pending'),
      closed('P6', 'pending'),
      closed('P7', 'pending'),
    ])
    expect(texts).toEqual([
      { text: MID_HEADER, dim: false },
      { text: 'component-builder build-implement PASS 12:51 · no transcript', dim: true },
      { text: 'remediation 0/2 · gate: none', dim: false },
    ])
  }
})

test('ledger pane 2. pressing a phase writes the inverse of what it shows; a stored choice holds across refreshes', async ($, on) => {
  const state = engine(on)
  answerFs(on, BUILD_MID_PHASE)
  await start($)
  const builderRun = 'component-builder build-implement PASS 12:51 · no transcript'

  await press($, 'phase:P1')
  expect(state.expanded).toEqual({ [WF]: { P1: true } })
  let drawn = await ledger($)
  expect(drawn.buttons[0].label).toBe('▾ P1 completed · 3 fixes')
  expect(drawn.texts.map(t => t.text)).toContain('— REM-FIX 1')

  await press($, 'phase:P3')
  expect(state.expanded).toEqual({ [WF]: { P1: true, P3: false } })
  await $.turn.complete(turnDone)
  drawn = await ledger($)
  expect(drawn.buttons.find(b => b.key === 'phase:P3')?.label).toBe('▸ P3 running · 0 fixes')
  expect(drawn.texts.map(t => t.text)).not.toContain(builderRun)
  expect(drawn.texts.map(t => t.text)).toContain('— REM-FIX 1')
})

test('ledger pane 3. a spawned reviewer is a running Button; after its APPROVE lands it is a step Button that opens its transcript', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  await $.agent.spawn(reviewer)
  expect((await ledger($)).buttons.map(b => b.key)).toContain('running:code-reviewer')

  disk.fixture = { ...BUILD_MID_PHASE, eventsText: BUILD_MID_PHASE.eventsText + APPROVE }
  await $.tool.call({ tool: 'Bash', command: "printf '...' >> .cc10x/workflows/" + WF + '.events.jsonl' })
  const key = 'step:' + parseEvents(BUILD_MID_PHASE.eventsText).length
  const { buttons } = await ledger($)
  expect(buttons.map(b => b.key)).not.toContain('running:code-reviewer')
  expect(buttons).toContainEqual({ key, label: 'code-reviewer build-review APPROVE 12:51' })

  await press($, key)
  expect(state.views).toEqual([{ agentId: 'agent-1' }])
  expect(state.toasts).toEqual([])
})

test('ledger pane 4. an unbound chain step is dim Text noting no transcript, never a Button; a non-chain result has no note', async ($, on) => {
  engine(on)
  answerFs(on, PLAN_AT_GAP1)
  await start($)

  const { buttons, texts } = await ledger($)
  expect(buttons).toEqual([{ key: 'phase:PLAN', label: '▾ PLAN running · 0 fixes' }])
  const steps = texts.filter(t => t.dim).map(t => t.text)
  expect(steps[0]).toBe('exploration plan DESIGN_SAVED 06:42')
  expect(steps[1]).toMatch(/^planner plan-create NEEDS_CLARIFICATION \d\d:\d\d · no transcript$/)
  expect(steps).toHaveLength(2)
})

test('ledger pane 5. viewing an agent draws back to conversation first, which views the main conversation; none in the main view', async ($, on) => {
  const state = engine(on)
  answerFs(on, BUILD_MID_PHASE)
  await start($)

  expect((await ledger($, { agentId: 'agent-1' })).buttons[0]).toEqual({ key: 'back', label: 'back to conversation' })
  await press($, 'back', { agentId: 'agent-1' })
  expect(state.views).toEqual([{}])
  expect((await ledger($)).buttons.map(b => b.key)).not.toContain('back')
})

test('ledger pane 6. a denied or rejected transcript view toasts its reason and writes no state', async ($, on) => {
  const state = engine(on)
  answerFs(on, BUILD_MID_PHASE)
  await start($)
  await $.agent.spawn(reviewer)

  state.viewDeny = 'no agent holds the id'
  await press($, 'running:code-reviewer')
  expect(state.toasts).toEqual(['cc10x: no agent holds the id'])

  state.viewDeny = ''
  state.viewReject = 'view hook refused'
  await press($, 'running:code-reviewer')
  expect(state.toasts).toHaveLength(2)
  expect(state.toasts[1]).toMatch(/^cc10x: .*view hook refused/)
  expect(state.expandedWrites).toBe(0)
})

test('ledger pane 7. a workflow that finishes draws its ledger: the finished header, seven phases with P7 open, no footer', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  disk.fixture = FINISHED_BUILD
  await $.turn.complete(turnDone)

  const { buttons, texts } = await ledger($)
  expect(texts[0].text).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54 · finished 2026-10-\d\dT/)
  expect(buttons.map(b => b.label)).toEqual([
    '▸ P1 completed · 3 fixes',
    '▸ P2 completed · 0 fixes',
    '▸ P3 completed · 3 fixes',
    '▸ P4 completed · 4 fixes',
    '▸ P5 completed · 4 fixes',
    '▸ P6 completed · 3 fixes',
    '▾ P7 completed · 0 fixes',
  ])
  expect(texts.slice(1).map(t => t.text)).toEqual(['router build-finish COMMITTED 07:09', 'router build-finish DONE 07:15'])
  expect(texts.some(t => /remediation|no live workflow/.test(t.text))).toBe(false)
})

test('ledger pane 8. a refused expanded write is logged and the pane still draws', async ($, on) => {
  const logs: string[] = []
  engine(on, logs, ['expanded'])
  answerFs(on, BUILD_MID_PHASE)
  await start($)

  await press($, 'phase:P1')
  expect(logs.some(l => l.startsWith('cc10x: expand failed:') && l.includes('state store down'))).toBe(true)
  const { buttons, texts } = await ledger($)
  expect(buttons[0].label).toBe('▸ P1 completed · 3 fixes')
  expect(texts[0].text).toBe(MID_HEADER)
})

test('ledger pane 8b. two presses with no redraw between them end where they started', async ($, on) => {
  const state = engine(on)
  answerFs(on, BUILD_MID_PHASE)
  await start($)

  const ui = await $.ui.mount({ plugin: 'cc10x', component: 'Pane', requestId: 'cc10x-loop', surface: 'terminal', props: paneProps })
  // Both presses land on the same drawing: the second is raised before the first's write redraws.
  await Promise.all([ui.press({ key: 'phase:P1' }), ui.press({ key: 'phase:P1' })])
  await ui.unmount()
  expect(state.expanded).toEqual({ [WF]: { P1: false } })
})

test('ledger pane 8c. a workflow that ended workflow_failed draws a failed header and a failed route row', async ($, on) => {
  engine(on)
  const failed = '{"ts": "2026-10-20T07:00:00Z", "wf": "wf-20261020T063253Z-c4eb6de6", "event": "workflow_failed", "phase": "plan", "agent": "router", "decision": "N/A", "details": {}}\n'
  answerFs(on, { ...PLAN_AT_GAP1, eventsText: PLAN_AT_GAP1.eventsText + failed })
  await start($)

  const { buttons, texts } = await ledger($)
  expect(texts[0].text).toBe('cc10x · PLAN wf-20261020T063253Z-c4eb6de6 · failed 2026-10-20T07:00:00Z')
  expect(buttons[0]).toEqual({ key: 'phase:PLAN', label: '▾ PLAN failed · 0 fixes' })
})

test('ledger pane 9. BUILD_REMEDIATION: P1 open shows the REM-FIX marker between hunter CLEAN and builder FIXED, remediation 1/2', async ($, on) => {
  engine(on)
  answerFs(on, BUILD_REMEDIATION)
  await start($)

  const lines = (await ledger($)).texts.map(t => t.text)
  expect(lines[0]).toBe('cc10x · BUILD ' + REM_WF + ' · /repo/loop-pane-fixture.md')
  const hunt = lines.findIndex(l => l.startsWith('failure-hunter build-hunt CLEAN'))
  expect(hunt).toBeGreaterThan(0)
  expect(lines[hunt + 1]).toBe('— REM-FIX 1')
  expect(lines[hunt + 2]).toMatch(/^component-builder build-implement FIXED 11:51/)
  expect(lines.at(-1)).toBe('remediation 1/2 · gate: none')
})

test('ledger pane stale. a loop view stored before the ledger existed draws its header and no phases, never a render failure', async ($, on) => {
  const logs: string[] = []
  engine(on, logs, ['preLedger'])
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  const live = await ledger($)
  expect(live.texts[0].text).toBe(MID_HEADER)
  expect(live.buttons).toEqual([])

  disk.fixture = FINISHED_BUILD
  await $.turn.complete(turnDone)
  const finished = await ledger($)
  expect(finished.texts[0].text).toMatch(/^cc10x · workflow wf-20261018T112922Z-7e99ef54 · finished 2026-10-/)
  expect(finished.buttons).toEqual([])
  expect(logs.some(l => l.includes('pane render failed'))).toBe(false)
})

test('pane 2. TRIAGE_NEEDS_INFO: the pending gate', async ($, on) => {
  engine(on)
  answerFs(on, TRIAGE_NEEDS_INFO)
  await start($)

  expect((await texts($)).some(l => /gate: needs_info/.test(l))).toBe(true)
})

test('pane 3. no workflow files: no live workflow', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.listing = 'empty'
  await start($)

  expect(await texts($)).toEqual(['no live workflow'])
})

test('pane 4. an artifact that reads [] keeps the previous live view and says artifact unreadable, dim', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  disk.fixture = { ...BUILD_MID_PHASE, artifactText: '[]' }
  await $.turn.complete(turnDone)

  const drawn = await pane($)
  expect(drawn[0].text).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54/)
  const error = drawn.find(t => /artifact unreadable/.test(t.text))
  expect(error?.dim).toBe(true)
})

test('pane 4b. an events log that cannot be read keeps the previous live view and says events log unreadable, dim', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  disk.denyLog = true
  await $.turn.complete(turnDone)

  const drawn = await pane($)
  expect(drawn[0].text).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54/)
  expect((await ledger($)).buttons.slice(0, 3).map(b => b.label)).toEqual(['▸ P1 completed · 3 fixes', '▸ P2 completed · 0 fixes', '▾ P3 running · 0 fixes'])
  const error = drawn.find(t => t.text.includes('events log unreadable'))
  expect(error?.dim).toBe(true)
  expect(error?.text).toContain('EACCES: log refused')
})

test('pane 5. the newest artifact with no events log yet is live with no events, not an error', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.log = false
  await start($)

  const lines = await texts($)
  expect(state.loop?.error).toBe(null)
  expect(lines[0]).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54/)
  expect(lines.some(l => /unreadable|missing|error/.test(l))).toBe(false)
})

test('pane 6. /cc10x-loop status names the chosen artifact and the error, or no live workflow', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)

  const ok = await $.command.run({ command: 'cc10x-loop', args: 'status' })
  expect(ok.text).toBe(BUILD_MID_PHASE.path + '\nsearched: ' + DIR)

  disk.denyRead = true
  const failing = await $.command.run({ command: 'cc10x-loop', args: 'status' })
  expect(failing.text).toContain(BUILD_MID_PHASE.path)
  expect(failing.text).toContain('EACCES: read refused')

  disk.denyRead = false
  disk.listing = 'empty'
  const idle = await $.command.run({ command: 'cc10x-loop', args: ' status ' })
  expect(idle.text).toBe('no live workflow\nsearched: ' + DIR)
})

test('pane 7. OD-1 B: on a docking surface a new live workflow opens the pane once; a second refresh does not', async ($, on) => {
  const opens: string[] = []
  const state = engine(on, [], [], opens)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  await band($, 'terminal', false, true)
  await $.turn.complete(turnDone)
  expect(opens).toEqual(['cc10x-loop'])

  await $.turn.complete(turnDone)
  await $.tool.call({ tool: 'Bash', command: 'cat .cc10x/workflows/x' })
  expect(opens).toEqual(['cc10x-loop'])
  // The id is read before it is written: later refreshes leave the opened atom alone.
  expect(state.openedWrites).toBe(1)

  // Another live workflow is new: it opens once more.
  disk.fixture = otherWf(BUILD_MID_PHASE)
  await $.turn.complete(turnDone)
  await $.turn.complete(turnDone)
  expect(opens).toEqual(['cc10x-loop', 'cc10x-loop'])
})

test('pane 7d. docking unknown: no unasked open and the id stays unmarked, so docking later still opens', async ($, on) => {
  const opens: string[] = []
  const state = engine(on, [], [], opens)
  answerFs(on, BUILD_MID_PHASE)
  await start($)
  await band($)
  await $.turn.complete(turnDone)
  expect(opens).toEqual([])
  expect(state.openedWrites).toBe(0)

  await band($, 'terminal', false, true)
  await $.turn.complete(turnDone)
  expect(opens).toEqual(['cc10x-loop'])
})

test('pane 7e. a main screen that does not dock never opens unasked; once it docks, one open', async ($, on) => {
  const opens: string[] = []
  engine(on, [], [], opens)
  answerFs(on, BUILD_MID_PHASE)
  await start($)
  await band($, 'terminal', false, false)
  await $.turn.complete(turnDone)
  await $.turn.complete(turnDone)
  expect(opens).toEqual([])

  await band($, 'desktop', false, true)
  await $.turn.complete(turnDone)
  await $.turn.complete(turnDone)
  expect(opens).toEqual(['cc10x-loop'])
})

test('pane 7f. a failed write of the opened atom is logged, not thrown into the refresh', async ($, on) => {
  const logs: string[] = []
  const opens: string[] = []
  const state = engine(on, logs, ['opened'], opens)
  answerFs(on, BUILD_MID_PHASE)
  await start($)
  await band($, 'terminal', false, true)
  await $.turn.complete(turnDone)

  expect(state.loop?.live?.wf).toBe(WF)
  expect(opens).toEqual([])
  expect(logs.some(l => l.includes('pane open failed') && l.includes('state store down'))).toBe(true)
  expect(logs.some(l => l.includes('loop refresh failed'))).toBe(false)
})

test('pane 7b. OD-1 B: with no live workflow the pane never opens unasked', async ($, on) => {
  const opens: string[] = []
  engine(on, [], [], opens)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.listing = 'empty'
  await start($)
  await $.turn.complete(turnDone)

  disk.listing = 'files'
  disk.fixture = FINISHED_BUILD
  await $.turn.complete(turnDone)

  expect(opens).toEqual([])
})

test('pane 7c. OD-1 B: a refused unasked open is logged and the loop still reads', async ($, on) => {
  const logs: string[] = []
  const state = engine(on, logs, ['ui.open'])
  answerFs(on, BUILD_MID_PHASE)
  await start($)
  await band($, 'terminal', false, true)
  await $.turn.complete(turnDone)

  expect(state.loop?.live?.wf).toBe(WF)
  expect(logs.some(l => l.includes('pane open failed') && l.includes('surface refused'))).toBe(true)
})

test('pane 9. a multi-line user_request is one header line, whitespace collapsed', async ($, on) => {
  engine(on)
  const request = '"user_request": "/repo/loop-pane-fixture.md"'
  answerFs(on, { ...BUILD_REMEDIATION, artifactText: BUILD_REMEDIATION.artifactText.replace(request, '"user_request": "fix the\\n\\n  pane   header"') })
  await start($)

  expect((await texts($))[0]).toBe('cc10x · BUILD ' + REM_WF + ' · fix the pane header')
})

test('carried 2. the error is a dim pane line; the band keeps only the stale marker', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  disk.denyRead = true
  await $.turn.complete(turnDone)

  const error = (await pane($)).find(t => /EACCES: read refused/.test(t.text))
  expect(error?.dim).toBe(true)
  const b = await band($)
  expect(b).toMatch(/ · stale$/)
  expect(b).not.toMatch(/EACCES/)
})

test('carried 3. past the breaker: pane remediation 5 (breaker 2), band rem 5', async ($, on) => {
  engine(on)
  const fix = JSON.stringify({ ts: '2026-10-18T11:52:00Z', wf: REM_WF, event: 'remediation_created', phase: 'build-implement', agent: 'router', decision: 'remfix', details: { phase_id: 'P1' } }) + '\n'
  answerFs(on, { ...BUILD_REMEDIATION, eventsText: BUILD_REMEDIATION.eventsText + fix.repeat(4) })
  await start($)

  expect(await texts($)).toContain('remediation 5 (breaker 2) · gate: none')
  expect(await band($)).toMatch(/ · rem 5$/)
})

test('pane warnings. a warning is a dim line', async ($, on) => {
  engine(on)
  answerFs(on, { ...BUILD_MID_PHASE, artifactText: BUILD_MID_PHASE.artifactText.replace('"workflow_type": "BUILD"', '"workflow_type": "constructor"') })
  await start($)

  const warning = (await pane($)).find(t => t.text.includes('unknown workflow type: constructor'))
  expect(warning?.dim).toBe(true)
})

test('cwd 1. a shell cd below the project root: the workflows dir is found from the session cwd upward', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.root = '/home'
  disk.cwd = '/repo/src/deep'
  await start($)

  expect((await texts($))[0]).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54/)
  const status = await $.command.run({ command: 'cc10x-loop', args: 'status' })
  expect(status.text).toBe(BUILD_MID_PHASE.path + '\nsearched: ' + DIR)
})

test('cwd 2. a cwd inside .cc10x/workflows itself resolves to that same directory', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.root = '/home'
  disk.cwd = DIR
  await start($)

  expect((await texts($))[0]).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54/)
})

test('cwd 3. no workflows dir above cwd falls back to the project root', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.cwd = '/tmp/elsewhere'
  await start($)

  expect((await texts($))[0]).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54/)
})

test('cwd 4. /cc10x-loop status says where it looked when no workflows dir is found', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.root = '/home'
  disk.cwd = '/tmp/elsewhere'
  await start($)

  const status = await $.command.run({ command: 'cc10x-loop', args: 'status' })
  expect(status.text).toBe('no live workflow\nno .cc10x/workflows found from /tmp/elsewhere')
})

test('cwd 5. a workflow the router starts under cwd (root elsewhere) auto-opens the docked pane once on its write', async ($, on) => {
  const opens: string[] = []
  engine(on, [], [], opens)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.root = '/home'
  disk.cwd = '/repo'
  disk.listing = 'missing'
  await start($)
  await band($, 'terminal', false, true)
  expect(opens).toEqual([])

  // The router's Write creates cwd/.cc10x/workflows with the new artifact and its events log.
  disk.listing = 'files'
  await $.tool.call({ tool: 'Write', file_path: BUILD_MID_PHASE.path, content: BUILD_MID_PHASE.artifactText })
  expect(opens).toEqual(['cc10x-loop'])

  await $.tool.call({ tool: 'Bash', command: "printf '...' >> .cc10x/workflows/" + WF + '.events.jsonl' })
  expect(opens).toEqual(['cc10x-loop'])
})

test('cwd 6. cwd at the project root: a live workflow in an ancestor .cc10x/workflows is not this project', async ($, on) => {
  const opens: string[] = []
  engine(on, [], [], opens)
  const disk = answerFs(on, BUILD_MID_PHASE)
  disk.root = '/repo/sub'
  disk.cwd = '/repo/sub'
  await start($)
  await band($, 'terminal', false, true)
  await $.turn.complete(turnDone)

  expect(await texts($)).toEqual(['no live workflow'])
  expect(opens).toEqual([])
})

test('cwd 7. cwd leaves for a dir with no workflows: the shown workflow keeps reading from its dir; gone, the pane says why', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  expect((await texts($))[0]).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54/)

  disk.cwd = '/tmp/elsewhere'
  disk.root = '/home'
  await $.turn.complete(turnDone)
  expect((await texts($))[0]).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54/)

  disk.listing = 'missing'
  await $.turn.complete(turnDone)
  const why = { text: 'no .cc10x/workflows found from /tmp/elsewhere', dim: true }
  expect(await pane($)).toEqual([{ text: 'no live workflow', dim: false }, why])

  // The reason stays while nothing is found, not just for the one refresh that dropped the view.
  await $.turn.complete(turnDone)
  expect(await pane($)).toEqual([{ text: 'no live workflow', dim: false }, why])
})

test('cwd 8. a child dir with only finished workflows falls through to a live one in its parent under the root', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  const child = '/repo/child/.cc10x/workflows'
  const finished = otherWf(FINISHED_BUILD)
  disk.extra = { [child]: { ...finished, path: child + finished.path.slice(finished.path.lastIndexOf('/')) } }
  disk.cwd = '/repo/child'
  await start($)

  expect((await texts($))[0]).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54/)
  expect(state.loop?.live?.path).toBe(BUILD_MID_PHASE.path)
  expect(state.loop?.last?.wf).toBe('wf-20261018T112922Z-0000beef')
  const status = await $.command.run({ command: 'cc10x-loop', args: 'status' })
  expect(status.text).toBe(BUILD_MID_PHASE.path + '\nsearched: ' + child + ', ' + DIR)
})

test('cwd 9. /cc10x-loop status after a refused session cwd answers with the status, never "pane did not open"', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  disk.denyCwd = true

  const status = await $.command.run({ command: 'cc10x-loop', args: 'status' })
  expect(status.text).not.toContain('did not open')
  expect(status.text?.split('\n')[0]).toBe(BUILD_MID_PHASE.path)
  expect(status.text).toContain('cwd refused')
})

// The fixture moved into another workflows dir, same file name.
const inDir = (dir: string, f: LoopFixture): LoopFixture => ({ ...f, path: dir + f.path.slice(f.path.lastIndexOf('/')) })
const notFound = (cwd: string) => [
  { text: 'no live workflow', dim: false },
  { text: 'no .cc10x/workflows found from ' + cwd, dim: true },
]

test('cwd 10. a cd to a sibling inside the root with no workflows: the reason line, never the sibling it left', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  const a = '/p/A/.cc10x/workflows'
  disk.listing = 'missing'
  disk.root = '/p'
  disk.extra = { [a]: inDir(a, BUILD_MID_PHASE) }
  disk.cwd = '/p/A'
  await start($)
  expect((await texts($))[0]).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54/)

  disk.cwd = '/p/B'
  await $.turn.complete(turnDone)
  expect(await pane($)).toEqual(notFound('/p/B'))
})

test('cwd 11. cd from a parent outside the root into the root with nothing live: never the parent workflow', async ($, on) => {
  engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  const parent = '/p/.cc10x/workflows'
  disk.listing = 'missing'
  disk.root = '/p/repo'
  disk.extra = { [parent]: inDir(parent, BUILD_MID_PHASE) }
  disk.cwd = '/p'
  await start($)
  expect((await texts($))[0]).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54/)

  disk.cwd = '/p/repo'
  await $.turn.complete(turnDone)
  expect(await pane($)).toEqual(notFound('/p/repo'))
})

test('cwd 12. outside the root, a shown workflow that finishes stays named as last across refreshes', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  await start($)
  disk.cwd = '/tmp/elsewhere'
  disk.root = '/home'
  await $.turn.complete(turnDone)
  expect((await texts($))[0]).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54/)

  disk.fixture = FINISHED_BUILD
  for (let i = 0; i < 3; i++) {
    await $.turn.complete(turnDone)
    expect(state.loop?.last?.wf).toBe(WF)
    expect((await texts($))[0]).toMatch(/^cc10x · BUILD wf-20261018T112922Z-7e99ef54 · finished 2026-10-/)
  }
})

test('cwd 13. a nearer workflows dir that cannot be listed is named in the error; a live one further up still shows', async ($, on) => {
  const state = engine(on)
  const disk = answerFs(on, BUILD_MID_PHASE)
  const child = '/repo/child/.cc10x/workflows'
  disk.refuseList = [child]
  disk.cwd = '/repo/child'
  await start($)

  expect(state.loop?.live?.path).toBe(BUILD_MID_PHASE.path)
  expect(state.loop?.error).toContain(child + ': ')
  expect(state.loop?.error).toContain('EACCES: list refused')
})

test('cwd 14. /cc10x-loop status when the loop state cannot be read answers with status text, never "pane did not open"', async ($, on) => {
  engine(on)
  answerFs(on, BUILD_MID_PHASE)
  let refuse = false
  on('state.get', (_, e, next) => {
    const r = e as { plugin: string; key: string }
    return refuse && r.plugin === 'cc10x' && r.key === 'loop' ? { deny: 'state store down' } : next(e)
  })
  await start($)
  refuse = true

  const status = await $.command.run({ command: 'cc10x-loop', args: 'status' })
  expect(status.text).not.toContain('did not open')
  expect(status.text).toContain('state store down')
})
