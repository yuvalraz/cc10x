export type StepStatus = 'done' | 'running' | 'pending'
export type Step = {
  agent: string
  phase: string
  status: StepStatus
  decision: string | null
  at: string | null
  startedAt: number | null
  parallel: boolean
  // true for a result that fits no chain row (appended after the chain, always done)
  extra: boolean
}
export type LoopEvent = {
  ts: string
  event: string
  agent: string
  phase: string
  decision: string | null
  reason: string | null
  phaseId: string
}
// `wf` is the spawning workflow's workflow_uuid (else workflow_id): a spawn binds rows of that workflow only.
// `wf` '' means the workflow is unknown: such a spawn never binds a row.
// `agentId`: the core's id for the started subagent, what `$.ui.view` opens; absent on records written before it was kept.
export type Spawn = { agent: string; atIndex: number; startedAt: number; phaseId: string; wf: string; agentId?: string }
// One ledger row's step: a result (`run`), a REM-FIX marker (`remfix`) or a live spawn (`running`).
export type LedgerStep = {
  kind: 'run' | 'remfix' | 'running'
  agent: string // event agent ('router' for remfix); spawn agent for running
  taskPhase: string // event `phase`; '' for running
  decision: string | null // event decision; null for running
  at: string | null // event ts; null for running
  startedAt: number | null // spawn startedAt for running; null otherwise
  agentId?: string // bound spawn's agentId (run) or the spawn's own (running)
}
export type LedgerPhase = { id: string; status: string; rounds: number; isCursor: boolean; steps: LedgerStep[] }
export type LoopState = {
  wf: string
  path: string
  type: string
  request: string
  phases: { id: string; status: string }[]
  cursor: string
  rawCursor: string | null
  steps: Step[]
  gate: string | null
  rounds: number
  events: LoopEvent[]
  otherLive: number
  warnings: string[]
  ledger: LedgerPhase[]
}
export type LoopView = {
  live: LoopState | null
  // `path`: the finished artifact, so a refresh from outside the root can re-read its dir.
  last: { wf: string; finishedAt: string; path: string; type: string; ledger: LedgerPhase[] } | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    // `opened`: the live workflow ids the pane already opened for unasked (OD-1 B), newest last.
    cc10x: { loop: LoopView; spawns: Spawn[]; opened: string[] }
  }
}
