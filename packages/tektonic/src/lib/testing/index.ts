import { App, Chart } from 'cdk8s';
import type { Pipeline } from '../core/pipeline';
import { TaskDef } from '../core/task';
import type { ImagePullPolicy } from '../core/task';
import type { LanguageName } from '../script';
import type { InjectedStepImage } from '../core/injected-image';

/**
 * Test helpers for asserting what a pipeline definition synthesizes to, in memory — no files
 * written, no cluster involved.
 *
 * Import from `@tektonic-ci/core/testing`:
 *
 * ```ts
 * import { synthPipeline, synthTask } from '@tektonic-ci/core/testing';
 *
 * it('skips the Go tasks on a frontend-only PR', () => {
 *   const pr = synthPipeline(prPipeline);
 *   expect(pr.has('go-test')).toBe(true);
 *   // The task runs only when the Go change-detection task says so.
 *   expect(pr.when('go-test')).toEqual([
 *     { input: '$(tasks.detect-go-changes.results.changed)', operator: 'in', values: ['true'] },
 *   ]);
 *   expect(pr.runAfter('go-test')).toContain('detect-go-changes');
 * });
 * ```
 */

/**
 * Conformance harness for authors of a `ScriptLanguage` — see `language-conformance.ts`.
 */
export {
  assertExitCodeContract,
  interpreterAvailable,
} from './language-conformance';
export type { ExitCodeContractOptions, ConformanceResult } from './language-conformance';

/**
 * Conformance suites for status reporters, cache backends and artifact stores — see
 * `provider-conformance.ts`.
 */
export {
  assertStatusReporterConformance,
  assertCacheBackendConformance,
  assertArtifactStoreConformance,
} from './provider-conformance';
export type { ProviderConformanceOptions } from './provider-conformance';

/** A single task entry in a synthesized pipeline spec. */
export interface PipelineTaskView {
  name: string;
  runAfter: string[];
  when: Record<string, unknown>[];
  params: Record<string, string>;
  workspaces: string[];
  retries?: number;
  timeout?: string;
  matrix?: Record<string, unknown>;
  /** The raw entry, for assertions the accessors above do not cover. */
  raw: Record<string, unknown>;
}

/** The synthesized pipeline spec plus accessors for the assertions tests actually make. */
export class PipelineView {
  constructor(
    /** The built spec: `params`, `workspaces`, `tasks`, and `finally`. */
    readonly spec: Record<string, unknown>,
  ) {}

  private entries(key: 'tasks' | 'finally'): Record<string, unknown>[] {
    const value = this.spec[key];
    return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  }

  private view(entry: Record<string, unknown>): PipelineTaskView {
    const params = Array.isArray(entry.params) ? (entry.params as { name: string; value: string }[]) : [];
    const workspaces = Array.isArray(entry.workspaces)
      ? (entry.workspaces as { name: string }[]).map(w => w.name)
      : [];
    return {
      name: String(entry.name),
      runAfter: Array.isArray(entry.runAfter) ? (entry.runAfter as string[]) : [],
      when: Array.isArray(entry.when) ? (entry.when as Record<string, unknown>[]) : [],
      params: Object.fromEntries(params.map(p => [p.name, p.value])),
      workspaces,
      retries: entry.retries as number | undefined,
      timeout: entry.timeout as string | undefined,
      matrix: entry.matrix as Record<string, unknown> | undefined,
      raw: entry,
    };
  }

  /** Names of the pipeline's regular tasks, in emitted (topological) order. */
  get taskNames(): string[] {
    return this.entries('tasks').map(t => String(t.name));
  }

  /** Names of the pipeline's `finally` tasks. */
  get finallyNames(): string[] {
    return this.entries('finally').map(t => String(t.name));
  }

  /** Pipeline-level param names. */
  get paramNames(): string[] {
    const params = this.spec.params;
    return Array.isArray(params) ? (params as { name: string }[]).map(p => p.name) : [];
  }

  /** Pipeline-level workspace names. */
  get workspaceNames(): string[] {
    const ws = this.spec.workspaces;
    return Array.isArray(ws) ? (ws as { name: string }[]).map(w => w.name) : [];
  }

  /** True when the pipeline emits a task (or finally task) with this name. */
  has(name: string): boolean {
    return [...this.taskNames, ...this.finallyNames].includes(name);
  }

  /**
   * The named task's entry. Throws listing every emitted name when it is absent — a missing
   * task is usually the point of the test, and `undefined.runAfter` is a poor way to learn it.
   */
  task(name: string): PipelineTaskView {
    const entry =
      this.entries('tasks').find(t => t.name === name) ?? this.entries('finally').find(t => t.name === name);
    if (!entry) {
      throw new Error(
        `pipeline has no task '${name}'. Tasks: ${this.taskNames.join(', ') || '(none)'}; ` +
          `finally: ${this.finallyNames.join(', ') || '(none)'}`,
      );
    }
    return this.view(entry);
  }

  /** The named task's `runAfter` edges. */
  runAfter(name: string): string[] {
    return this.task(name).runAfter;
  }

  /** The named task's effective `when` clauses — `[]` when it runs unconditionally. */
  when(name: string): Record<string, unknown>[] {
    return this.task(name).when;
  }

  /** True when the named task carries a `when` guard, from its own attribute or `gated()`. */
  isGated(name: string): boolean {
    return this.when(name).length > 0;
  }

  /** The values bound to the named task's params, keyed by param name. */
  params(name: string): Record<string, string> {
    return this.task(name).params;
  }
}

/** Options mirroring the project-level defaults that affect synthesis. */
export interface SynthOptions {
  /** Name prefix applied to emitted resource names, as `TektonicProject.name` does. */
  namePrefix?: string;
  /** Extra pipeline-level params, as `TektonicProject` injects for PAC. */
  extraParams?: Record<string, unknown>[];
  /** Namespace for a synthesized Task manifest. Defaults to `'default'`. */
  namespace?: string;
  /** Project-level step security context, as `TektonicProject.defaultStepSecurityContext`. */
  stepSecurityContext?: Record<string, unknown>;
  /** Project-level default script language. */
  defaultLanguage?: LanguageName;
  /** Project-level default image pull policy. */
  defaultImagePullPolicy?: ImagePullPolicy;
  /** Project-level image for injected steps, as `TektonicProject.injectedStepImage`. */
  injectedStepImage?: InjectedStepImage;
  /** Project-level TEP-0147 provenance switch, as `TektonicProject.artifactProvenance`. */
  artifactProvenance?: boolean;
}

/**
 * Builds a pipeline's spec in memory and wraps it for assertions.
 *
 * This runs the same code path `TektonicProject` uses to inline the spec into a PAC
 * PipelineRun — validation, topological sort, `runAfter` wiring, `gated()` overrides — so a
 * test sees exactly what would be emitted.
 */
export function synthPipeline(pipeline: Pipeline, opts: SynthOptions = {}): PipelineView {
  return new PipelineView(pipeline._buildSpec(opts.extraParams, opts.namePrefix));
}

/** A synthesized Task manifest plus accessors for its steps. */
export class TaskView {
  constructor(
    /** The full Task manifest, exactly as it would be written to `<outdir>/tasks/`. */
    readonly manifest: Record<string, unknown>,
  ) {}

  private get spec(): Record<string, unknown> {
    return (this.manifest.spec ?? {}) as Record<string, unknown>;
  }

  private get steps(): Record<string, unknown>[] {
    const steps = this.spec.steps;
    return Array.isArray(steps) ? (steps as Record<string, unknown>[]) : [];
  }

  /** The emitted resource name, including any project prefix. */
  get name(): string {
    return String((this.manifest.metadata as Record<string, unknown> | undefined)?.name ?? '');
  }

  /**
   * Step names in emitted order — including the framework's injected steps (cache
   * restore/save, the reporter's `report-status`), since their presence and position is
   * often what a test is checking.
   */
  get stepNames(): string[] {
    return this.steps.map(s => String(s.name));
  }

  /** Param names declared on the task, including any merged in by a status reporter. */
  get paramNames(): string[] {
    const params = this.spec.params;
    return Array.isArray(params) ? (params as { name: string }[]).map(p => p.name) : [];
  }

  /** The named step. Throws listing every step name when it is absent. */
  step(name: string): Record<string, unknown> {
    const step = this.steps.find(s => s.name === name);
    if (!step) {
      throw new Error(`task '${this.name}' has no step '${name}'. Steps: ${this.stepNames.join(', ')}`);
    }
    return step;
  }

  /** The named step's rendered script, wrapper and all. */
  script(stepName: string): string {
    return String(this.step(stepName).script ?? '');
  }
}

/** Synthesizes a single Task manifest in memory. */
export function synthTask(task: TaskDef, opts: SynthOptions = {}): TaskView {
  const chart = new Chart(new App(), task.name);
  task.synth(chart, opts.namespace ?? 'default', {
    namePrefix: opts.namePrefix,
    stepSecurityContext: opts.stepSecurityContext,
    defaultLanguage: opts.defaultLanguage,
    defaultImagePullPolicy: opts.defaultImagePullPolicy,
    injectedStepImage: opts.injectedStepImage,
    artifactProvenance: opts.artifactProvenance,
  });
  return new TaskView(chart.toJson()[0] as Record<string, unknown>);
}

/**
 * Synthesizes every task a pipeline emits, keyed by task name — the in-memory equivalent of
 * the `<outdir>/tasks/` directory. Non-synthesizable nodes (hub task refs) are skipped.
 */
export function synthTasks(pipeline: Pipeline, opts: SynthOptions = {}): Record<string, TaskView> {
  const out: Record<string, TaskView> = {};
  for (const task of [...pipeline.allTasks, ...pipeline.finallyTasks]) {
    if (!(task instanceof TaskDef)) continue;
    out[task.name] = synthTask(task, opts);
  }
  return out;
}
