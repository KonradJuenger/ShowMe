"use strict";

class BoundedLatestFrameQueue {
  constructor({ maxActive = 2, consume, release }) {
    if (!Number.isInteger(maxActive) || maxActive < 1)
      throw new Error("maxActive must be a positive integer");
    if (typeof consume !== "function" || typeof release !== "function")
      throw new Error("consume and release callbacks are required");
    this.maxActive = maxActive;
    this.consume = consume;
    this.release = release;
    this.active = 0;
    this.pending = null;
    this.closed = false;
    this.metrics = {
      offered: 0,
      consumed: 0,
      staleReleased: 0,
      rejectedAfterClose: 0,
      consumerErrors: 0,
      maxActive: 0,
      maxRetained: 0,
    };
  }

  offer(frame) {
    this.metrics.offered++;
    if (this.closed) {
      this.metrics.rejectedAfterClose++;
      this.release(frame, "closed");
      return;
    }
    if (this.active < this.maxActive) {
      this.#start(frame);
      return;
    }
    if (this.pending) {
      this.metrics.staleReleased++;
      this.release(this.pending, "stale");
    }
    this.pending = frame;
    this.#observeRetained();
  }

  close() {
    this.closed = true;
    if (this.pending) {
      this.release(this.pending, "close");
      this.pending = null;
    }
    this.#observeRetained();
  }

  snapshot() {
    return {
      ...this.metrics,
      active: this.active,
      pending: this.pending ? 1 : 0,
      retained: this.active + (this.pending ? 1 : 0),
      closed: this.closed,
    };
  }

  #observeRetained() {
    this.metrics.maxActive = Math.max(this.metrics.maxActive, this.active);
    this.metrics.maxRetained = Math.max(
      this.metrics.maxRetained,
      this.active + (this.pending ? 1 : 0),
    );
  }

  #start(frame) {
    this.active++;
    this.metrics.consumed++;
    this.#observeRetained();
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      this.active--;
      this.#pump();
    };
    try {
      Promise.resolve(this.consume(frame, done)).catch(() => {
        this.metrics.consumerErrors++;
        this.release(frame, "consumer-error");
        done();
      });
    } catch {
      this.metrics.consumerErrors++;
      this.release(frame, "consumer-error");
      done();
    }
  }

  #pump() {
    if (this.closed || !this.pending || this.active >= this.maxActive) {
      this.#observeRetained();
      return;
    }
    const next = this.pending;
    this.pending = null;
    this.#start(next);
  }
}

module.exports = { BoundedLatestFrameQueue };
