/** Renderer-local dependency execution. An independent terminal never waits for
 * an unrelated stack; consumers share one in-flight resolution of their inputs. */
export class EffectGraph<Key> {
  private nodes = new Map<
    Key,
    {
      inputs: Key[];
      execute(): void | Promise<void>;
      dirty: number;
      resolved: number;
      pending?: Promise<void>;
    }
  >();
  private consumers = new Map<Key, Set<Key>>();
  register(key: Key, execute: () => void | Promise<void>) {
    this.nodes.set(key, { inputs: [], execute, dirty: 1, resolved: 0 });
  }
  remove(key: Key) {
    this.invalidate(key);
    this.nodes.delete(key);
    this.consumers.delete(key);
    for (const users of this.consumers.values()) users.delete(key);
  }
  compile(inputs: (key: Key) => Key[]) {
    this.consumers.clear();
    const changed: Key[] = [];
    for (const [key, node] of this.nodes) {
      const next = inputs(key).filter(
        (input) => input !== key && this.nodes.has(input),
      );
      if (
        next.length !== node.inputs.length ||
        next.some((input, index) => input !== node.inputs[index])
      ) {
        changed.push(key);
        node.inputs = next;
      }
      for (const input of node.inputs) {
        const users = this.consumers.get(input) ?? new Set<Key>();
        users.add(key);
        this.consumers.set(input, users);
      }
    }
    // Reject a dependency cycle at planning time, rather than waiting forever.
    const active = new Set<Key>(),
      complete = new Set<Key>();
    const visit = (key: Key) => {
      if (complete.has(key)) return;
      if (active.has(key))
        throw new Error("Effect rendering dependencies contain a cycle");
      active.add(key);
      this.nodes.get(key)?.inputs.forEach(visit);
      active.delete(key);
      complete.add(key);
    };
    for (const key of this.nodes.keys()) visit(key);
    changed.forEach((key) => this.invalidate(key));
  }
  invalidate(key: Key) {
    const seen = new Set<Key>();
    const dirty = (key: Key) => {
      if (seen.has(key)) return;
      seen.add(key);
      const node = this.nodes.get(key);
      if (node) node.dirty++;
      this.consumers.get(key)?.forEach(dirty);
    };
    dirty(key);
  }
  resolve(key: Key, published?: (key: Key) => boolean): Promise<void> {
    return this.resolveNode(key, published, false);
  }
  private resolveNode(
    key: Key,
    published: ((key: Key) => boolean) | undefined,
    inputsPrepared: boolean,
  ): Promise<void> {
    const node = this.nodes.get(key);
    if (!node) return Promise.resolve();
    if (node.pending) return node.pending;
    if (node.resolved === node.dirty) return Promise.resolve();
    const work = async () => {
      const inputs = node.inputs;
      if (!inputsPrepared)
        await Promise.all(
          inputs.map((input) => {
            // Interactive GPU consumers can animate a published input while its
            // next native snapshot paints. Explicit flushes omit this option.
            if (this.nodes.get(input)?.pending && published?.(input)) return;
            return this.resolve(input, published);
          }),
        );
      // Teardown/replacement while inputs were pending invalidates this request.
      if (this.nodes.get(key) !== node || node.inputs !== inputs) return;
      // Input publication during dependency resolution belongs to this request.
      const version = node.dirty;
      await node.execute();
      // A cohort can intentionally retain an earlier input while a new video
      // frame arrives. Keep that newer invalidation for the next request.
      if (!inputsPrepared || !node.inputs.some((input) => this.isDirty(input)))
        node.resolved = version;
    };
    node.pending = work().finally(() => {
      node.pending = undefined;
    });
    return node.pending;
  }
  isDirty(key: Key) {
    const node = this.nodes.get(key);
    return !!node && node.resolved !== node.dirty;
  }
  flush(key: Key, cohort = new Map<Key, Promise<void>>()): Promise<void> {
    const existing = cohort.get(key);
    if (existing) return existing;
    const node = this.nodes.get(key);
    if (!node) return Promise.resolve();
    // A prior interactive request may have used published inputs. Resolve the
    // requested dependency cohort before accepting its terminal as settled.
    const work = async () => {
      const inputs = node.inputs;
      await Promise.all(inputs.map((input) => this.flush(input, cohort)));
      await node.pending;
      if (this.nodes.get(key) !== node) return;
      if (node.inputs !== inputs) {
        await this.flush(key);
        return;
      }
      await this.resolveNode(key, undefined, true);
    };
    const pending = work();
    cohort.set(key, pending);
    return pending;
  }
}
