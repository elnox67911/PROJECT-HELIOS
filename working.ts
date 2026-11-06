import type { Store } from "../db/store";

export interface WorkingMemoryState {
  objective: string;
  taskId: string | null;
  taskTitle: string | null;
  planSummary: string;
  activeFiles: string[];
  changedFiles: string[];
  recentToolOutputs: Array<{ tool: string; summary: string; at: string }>;
  unresolved: string[];
  notes: string[];
  step: number;
  phase: string;
}

const MAX_RECENT_OUTPUTS = 12;
const MAX_NOTES = 24;
const MAX_FILES = 80;

/**
 * Per-run scratch state. It is small, mutable, and persisted after each step so
 * an interrupted run can be resumed with its active files and open issues.
 */
export class WorkingMemory {
  private constructor(private state: WorkingMemoryState) {}

  static create(objective: string, planSummary = ""): WorkingMemory {
    return new WorkingMemory({
      objective,
      taskId: null,
      taskTitle: null,
      planSummary,
      activeFiles: [],
      changedFiles: [],
      recentToolOutputs: [],
      unresolved: [],
      notes: [],
      step: 0,
      phase: "understand",
    });
  }

  static load(store: Store, runId: string, fallbackObjective: string): WorkingMemory {
    const saved = store.loadWorkingMemory<WorkingMemoryState>(runId);
    if (saved && typeof saved.objective === "string") {
      return new WorkingMemory({ ...saved });
    }
    return WorkingMemory.create(fallbackObjective);
  }

  get snapshot(): WorkingMemoryState {
    return {
      ...this.state,
      activeFiles: [...this.state.activeFiles],
      changedFiles: [...this.state.changedFiles],
      recentToolOutputs: [...this.state.recentToolOutputs],
      unresolved: [...this.state.unresolved],
      notes: [...this.state.notes],
    };
  }

  setPhase(phase: string): void {
    this.state.phase = phase;
  }

  setPlanSummary(summary: string): void {
    this.state.planSummary = summary;
  }

  setTask(taskId: string | null, title: string | null): void {
    this.state.taskId = taskId;
    this.state.taskTitle = title;
    this.state.step = 0;
  }

  incrementStep(): number {
    this.state.step += 1;
    return this.state.step;
  }

  touchFile(path: string): void {
    if (!this.state.activeFiles.includes(path)) {
      this.state.activeFiles.push(path);
      if (this.state.activeFiles.length > MAX_FILES) this.state.activeFiles.shift();
    }
  }

  recordChangedFiles(paths: string[]): void {
    for (const path of paths) {
      this.touchFile(path);
      if (!this.state.changedFiles.includes(path)) this.state.changedFiles.push(path);
    }
  }

  recordToolOutput(tool: string, summary: string): void {
    this.state.recentToolOutputs.push({
      tool,
      summary: summary.length > 2000 ? `${summary.slice(0, 2000)}…` : summary,
      at: new Date().toISOString(),
    });
    if (this.state.recentToolOutputs.length > MAX_RECENT_OUTPUTS) {
      this.state.recentToolOutputs.shift();
    }
  }

  addIssue(issue: string): void {
    if (!this.state.unresolved.includes(issue)) this.state.unresolved.push(issue);
  }

  resolveIssue(issue: string): void {
    this.state.unresolved = this.state.unresolved.filter((i) => i !== issue);
  }

  addNote(note: string): void {
    this.state.notes.push(note);
    if (this.state.notes.length > MAX_NOTES) this.state.notes.shift();
  }

  persist(store: Store, runId: string): void {
    store.saveWorkingMemory(runId, this.state);
  }

  renderForPrompt(): string {
    const s = this.state;
    const parts: string[] = [];
    parts.push(`Phase: ${s.phase}`);
    if (s.taskTitle) parts.push(`Current task: ${s.taskTitle}`);
    if (s.activeFiles.length) parts.push(`Active files: ${s.activeFiles.slice(-12).join(", ")}`);
    if (s.changedFiles.length) parts.push(`Changed files this run: ${s.changedFiles.join(", ")}`);
    if (s.unresolved.length) parts.push(`Open issues:\n- ${s.unresolved.join("\n- ")}`);
    if (s.recentToolOutputs.length) {
      const recent = s.recentToolOutputs
        .slice(-4)
        .map((o) => `- ${o.tool}: ${o.summary.slice(0, 300)}`)
        .join("\n");
      parts.push(`Recent tool results:\n${recent}`);
    }
    if (s.notes.length) parts.push(`Notes:\n- ${s.notes.slice(-8).join("\n- ")}`);
    return parts.join("\n");
  }
}
