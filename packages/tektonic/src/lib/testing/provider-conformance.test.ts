import { describe, it, expect } from 'vitest';
import {
  assertStatusReporterConformance,
  assertCacheBackendConformance,
  assertArtifactStoreConformance,
} from './provider-conformance';
import { TestStatusReporter } from '../../__fixtures__/reporter';
import { PvcBackend } from '../cache/pvc-backend';
import { WorkspaceArtifactStore } from '../core/artifact';
import type { TaskArtifact } from '../core/artifact';
import type { TaskCacheSpec, TaskStepSpec } from '../core/task';
import type { BackendCtx } from '../core/cache-backend';
import { Task } from '../core/task';

const withNushell = { injectedStepImage: { image: 'ghcr.io/example/ci:1', provides: ['sh', 'git', 'nushell', 'tar', 'zstd'] as const } };

describe('assertStatusReporterConformance', () => {
  it('passes the reference reporter', () => {
    const r = assertStatusReporterConformance(() => new TestStatusReporter(), withNushell);
    expect(r.checks).toContain('one pending task, ahead of every reporting task');
    expect(r.checks).toContain("reconciler lands in finally and reads every reporting task's status");
  });

  it('surfaces a capability the project image must provide', () => {
    expect(() => assertStatusReporterConformance(() => new TestStatusReporter())).toThrow(/nushell/);
  });

  it('fails a pending task that ignores the name it is given', () => {
    class Unscoped extends TestStatusReporter {
      override createPendingTask(contexts: string[]): Task {
        return super.createPendingTask(contexts, 'set-status-pending');
      }
    }
    expect(() => assertStatusReporterConformance(() => new Unscoped(), withNushell)).toThrow(
      /createPendingTask ignored the name/,
    );
  });

  it('fails a pending task that drops contexts', () => {
    class FirstOnly extends TestStatusReporter {
      override createPendingTask(contexts: string[], name?: string): Task {
        return super.createPendingTask(contexts.slice(0, 1), name);
      }
    }
    expect(() => assertStatusReporterConformance(() => new FirstOnly(), withNushell)).toThrow(
      /drops a context: 'conformance\/test'/,
    );
  });

  it('fails a final step that takes a common step name', () => {
    class Greedy extends TestStatusReporter {
      override finalStep(context: string, names: string[] = []): TaskStepSpec {
        return { ...super.finalStep(context, names), name: 'build' };
      }
    }
    expect(() => assertStatusReporterConformance(() => new Greedy(), withNushell)).toThrow(/may collide/);
  });

  it('fails a final step with an invalid name', () => {
    class Shouting extends TestStatusReporter {
      override finalStep(context: string, names: string[] = []): TaskStepSpec {
        return { ...super.finalStep(context, names), name: 'Report_Status' };
      }
    }
    expect(() => assertStatusReporterConformance(() => new Shouting(), withNushell)).toThrow(/not a DNS label/);
  });

  it('fails a non-deterministic final step', () => {
    let n = 0;
    class Counting extends TestStatusReporter {
      override finalStep(context: string, names: string[] = []): TaskStepSpec {
        return { ...super.finalStep(context, names), env: [{ name: 'N', value: String(n++) }] };
      }
    }
    expect(() => assertStatusReporterConformance(() => new Counting(), withNushell)).toThrow(/not deterministic/);
  });

  it('fails an unstable group key', () => {
    let n = 0;
    class Drifting extends TestStatusReporter {
      override pendingGroupKey(): string {
        return String(n++);
      }
    }
    expect(() => assertStatusReporterConformance(() => new Drifting(), withNushell)).toThrow(/pendingGroupKey/);
  });

  it('fails a reconciler that does not read task status', () => {
    class Blind extends TestStatusReporter {
      override createStatusReconcilerTask(entries: { taskName: string; context: string }[], name?: string): Task {
        return super.createStatusReconcilerTask(entries.slice(0, 1), name);
      }
    }
    expect(() => assertStatusReporterConformance(() => new Blind(), withNushell)).toThrow(/does not read a reporting task's status/);
  });
});

describe('assertCacheBackendConformance', () => {
  it('passes the PVC backend', () => {
    const r = assertCacheBackendConformance(() => new PvcBackend(), withNushell);
    expect(r.checks).toContain('spec.image overrides the step image');
    expect(r.checks).toContain("saveStrategy 'finally' synthesizes a separate save task");
  });

  it('fails steps named without the cache name', () => {
    class Fixed extends PvcBackend {
      override restoreStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
        return { ...super.restoreStep(spec, ctx), name: 'restore-cache' };
      }
    }
    expect(() => assertCacheBackendConformance(() => new Fixed(), withNushell)).toThrow(/step names collide/);
  });

  it('fails a backend that ignores spec.image', () => {
    class Stubborn extends PvcBackend {
      override saveStep(spec: TaskCacheSpec, ctx: BackendCtx): TaskStepSpec {
        return { ...super.saveStep(spec, ctx), image: 'registry.example/own:1' };
      }
    }
    expect(() => assertCacheBackendConformance(() => new Stubborn(), withNushell)).toThrow(
      /save step ignores spec\.image/,
    );
  });

  it('fails a backend with no type', () => {
    class Anonymous extends PvcBackend {
      override readonly type = '' as 'pvc';
    }
    expect(() => assertCacheBackendConformance(() => new Anonymous(), withNushell)).toThrow(/type/);
  });
});

describe('assertArtifactStoreConformance', () => {
  it('passes the workspace store', () => {
    const r = assertArtifactStoreConformance(() => new WorkspaceArtifactStore(), withNushell);
    expect(r.checks).toContain('path is absolute, stable, and has one writer');
  });

  it('fails a store whose path ignores the producer', () => {
    class Shared extends WorkspaceArtifactStore {
      override path(artifact: TaskArtifact): string {
        return `/workspace/artifacts/${artifact.name}`;
      }
    }
    expect(() => assertArtifactStoreConformance(() => new Shared(), withNushell)).toThrow(/path is shared/);
  });

  it('fails a relative path', () => {
    class Relative extends WorkspaceArtifactStore {
      override path(artifact: TaskArtifact): string {
        return `artifacts/${artifact.producerName}/${artifact.name}`;
      }
    }
    expect(() => assertArtifactStoreConformance(() => new Relative(), withNushell)).toThrow(/not absolute/);
  });

  it('fails a uri without a scheme', () => {
    class Schemeless extends WorkspaceArtifactStore {
      uri(artifact: TaskArtifact): string {
        return this.path(artifact);
      }
    }
    expect(() => assertArtifactStoreConformance(() => new Schemeless(), withNushell)).toThrow(/uri has no scheme/);
  });
});
