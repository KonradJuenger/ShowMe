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
    this.nodes.delete(key);
    this.consumers.delete(key);
    for (const users of this.consumers.values()) users.delete(key);
  }
  compile(inputs: (key: Key) => Key[]) {
    this.consumers.clear();
    for (const [key, node] of this.nodes) {
      node.inputs = inputs(key).filter(
        (input) => input !== key && this.nodes.has(input),
      );
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
    const node = this.nodes.get(key);
    if (!node) return Promise.resolve();
    if (node.pending) return node.pending;
    if (node.resolved === node.dirty) return Promise.resolve();
    const work = async () => {
      await Promise.all(
        node.inputs.map((input) => {
          // Interactive GPU consumers can animate a published input while its
          // next native snapshot paints. Explicit flushes omit this option.
          if (this.nodes.get(input)?.pending && published?.(input)) return;
          return this.resolve(input, published);
        }),
      );
      // Input publication during dependency resolution belongs to this request.
      const version = node.dirty;
      await node.execute();
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
      await Promise.all(node.inputs.map((input) => this.flush(input, cohort)));
      await node.pending;
      await this.resolve(key);
    };
    const pending = work();
    cohort.set(key, pending);
    return pending;
  }
}
