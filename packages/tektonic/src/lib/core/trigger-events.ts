/** GitHub webhook event types that can trigger a pipeline. */
export enum TRIGGER_EVENTS {
  /** Fires on pushes to branches, never on tag pushes: use {@link TAG} for those. */
  PUSH = 'push',
  /** Fires on pull request opened/synchronized events. */
  PULL_REQUEST = 'pull_request',
  /** Fires on tag pushes (a `push` event whose ref is under `refs/tags/`), never on branch pushes. */
  TAG = 'tag',
}
