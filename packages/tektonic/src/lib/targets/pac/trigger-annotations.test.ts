import { describe, it, expect } from 'vitest';
import { triggerAnnotations } from './trigger-annotations';
import { TRIGGER_EVENTS } from '../../core/trigger-events';

const PAC = 'pipelinesascode.tekton.dev';

describe('triggerAnnotations — simple (single rule) → discrete', () => {
  it('emits on-event / on-target-branch / on-path-changed', () => {
    const a = triggerAnnotations({
      rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST, branch: 'main', pathsChanged: ['src/**'] }],
    });
    expect(a[`${PAC}/on-event`]).toBe('[pull_request]');
    expect(a[`${PAC}/on-target-branch`]).toBe('[main]');
    expect(a[`${PAC}/on-path-changed`]).toBe('[src/**]');
    expect(a[`${PAC}/on-cel-expression`]).toBeUndefined();
  });

  it('forces refs/tags/* for TAG', () => {
    expect(triggerAnnotations({ rules: [{ on: TRIGGER_EVENTS.TAG }] })[`${PAC}/on-target-branch`]).toBe('[refs/tags/*]');
  });

  it('keeps a PUSH on exact branch names discrete: none of them can match a tag ref', () => {
    const a = triggerAnnotations({ rules: [{ on: TRIGGER_EVENTS.PUSH, branch: ['main', 'develop'] }] });
    expect(a[`${PAC}/on-event`]).toBe('[push]');
    expect(a[`${PAC}/on-target-branch`]).toBe('[main, develop]');
  });
});

// PAC delivers branch and tag pushes as the same `push` event, and on-target-branch: [*]
// matches refs/tags/* as well, so a push pipeline also ran on every release tag.
describe('triggerAnnotations — PUSH and TAG stay apart', () => {
  const excludesTags = "(event == 'push' && !target_branch.startsWith('refs/tags/'))";
  const onlyTags = "(event == 'push' && target_branch.startsWith('refs/tags/'))";

  it('a PUSH on any branch excludes tag pushes', () => {
    const a = triggerAnnotations({ rules: [{ on: TRIGGER_EVENTS.PUSH }] });
    expect(a[`${PAC}/on-event`]).toBeUndefined();
    expect(a[`${PAC}/on-target-branch`]).toBeUndefined();
    expect(a[`${PAC}/on-cel-expression`]).toBe(excludesTags);
  });

  it('a PUSH on a branch glob excludes tag pushes', () => {
    const cel = triggerAnnotations({ rules: [{ on: TRIGGER_EVENTS.PUSH, branch: 'release/*' }] })[`${PAC}/on-cel-expression`];
    expect(cel).toBe(`(${excludesTags} && target_branch.matches('^release/[^/]*$'))`);
  });

  it('a TAG rule in CEL fires on tags only', () => {
    const cel = triggerAnnotations({
      rules: [{ on: TRIGGER_EVENTS.TAG }, { on: TRIGGER_EVENTS.PULL_REQUEST }],
    })[`${PAC}/on-cel-expression`];
    expect(cel).toBe(`${onlyTags} || event == 'pull_request'`);
  });

  it('PUSH and TAG together fire on every push', () => {
    const cel = triggerAnnotations({
      rules: [{ on: [TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.TAG] }, { on: TRIGGER_EVENTS.PULL_REQUEST }],
    })[`${PAC}/on-cel-expression`];
    expect(cel).toBe("event == 'push' || event == 'pull_request'");
  });
});

describe('triggerAnnotations — compound → on-cel-expression', () => {
  it('OR-joins rules and folds event/branch/source/paths into CEL', () => {
    const a = triggerAnnotations({
      rules: [
        { on: [TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST], branch: 'main' },
        { on: TRIGGER_EVENTS.PULL_REQUEST, sourceBranch: 'feature/*', pathsChanged: ['src/**'] },
      ],
    });
    const cel = a[`${PAC}/on-cel-expression`];
    expect(cel).toBeDefined();
    expect(a[`${PAC}/on-event`]).toBeUndefined();
    expect(cel).toContain("((event == 'push' && !target_branch.startsWith('refs/tags/')) || event == 'pull_request')");
    expect(cel).toContain("target_branch == 'main'");
    expect(cel).toContain("source_branch.matches('^feature/[^/]*$')");
    expect(cel).toContain("files.all.exists(f, f.matches('^src/.*$'))");
    expect(cel).toContain(' || ');
  });

  it('a single rule with a sourceBranch also uses CEL', () => {
    const a = triggerAnnotations({ rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST, sourceBranch: 'feature/*' }] });
    expect(a[`${PAC}/on-cel-expression`]).toContain("source_branch.matches(");
    expect(a[`${PAC}/on-event`]).toBeUndefined();
  });

  it('raw cel replaces the whole expression', () => {
    const a = triggerAnnotations({ rules: [{ on: TRIGGER_EVENTS.PUSH }], cel: "event == 'push'" });
    expect(a[`${PAC}/on-cel-expression`]).toBe("event == 'push'");
  });
});

describe('triggerAnnotations — orthogonal annotations', () => {
  it('emits comment / label / cancel-in-progress in both modes', () => {
    const a = triggerAnnotations({
      rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST, branch: 'main' }],
      comment: '^/ci',
      labels: ['ci', 'ready'],
      cancelInProgress: true,
    });
    expect(a[`${PAC}/on-comment`]).toBe('^/ci');
    expect(a[`${PAC}/on-label`]).toBe('[ci, ready]');
    expect(a[`${PAC}/cancel-in-progress`]).toBe('true');
  });
});
