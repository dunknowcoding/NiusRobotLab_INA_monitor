export type Priority = 0 | 1 | 2; // 0=highest

export type QueueItem<T> = {
  priority: Priority;
  enqueuedAt_ms: number;
  value: T;
};

/**
 * A small binary-heap priority queue.
 * Designed for "control plane" tasks to preempt "data plane" tasks.
 */
export class PriorityQueue<T> {
  private heap: QueueItem<T>[] = [];
  private readonly capacity: number;

  constructor(opts: { capacity: number }) {
    if (!Number.isFinite(opts.capacity) || opts.capacity <= 0) {
      throw new Error("PriorityQueue capacity must be > 0");
    }
    this.capacity = opts.capacity;
  }

  size() {
    return this.heap.length;
  }

  isEmpty() {
    return this.heap.length === 0;
  }

  peek(): QueueItem<T> | undefined {
    return this.heap[0];
  }

  /**
   * Enqueue with bounded capacity.
   * Drop policy: if full, drop one lowest-priority item; if all are higher priority than new item, drop new.
   */
  enqueue(priority: Priority, value: T, now_ms = Date.now()): { accepted: boolean; dropped?: QueueItem<T> } {
    const item: QueueItem<T> = { priority, value, enqueuedAt_ms: now_ms };

    if (this.heap.length >= this.capacity) {
      const lowestIdx = this.findLowestPriorityIndex();
      const lowest = this.heap[lowestIdx]!;
      if (lowest.priority > item.priority) {
        this.removeAt(lowestIdx);
        this.push(item);
        return { accepted: true, dropped: lowest };
      }
      return { accepted: false, dropped: item };
    }

    this.push(item);
    return { accepted: true };
  }

  dequeue(): QueueItem<T> | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private push(item: QueueItem<T>) {
    this.heap.push(item);
    this.siftUp(this.heap.length - 1);
  }

  private siftUp(i: number) {
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.less(i, p)) {
        this.swap(i, p);
        i = p;
      } else {
        break;
      }
    }
  }

  private siftDown(i: number) {
    const n = this.heap.length;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let best = i;
      if (l < n && this.less(l, best)) best = l;
      if (r < n && this.less(r, best)) best = r;
      if (best !== i) {
        this.swap(i, best);
        i = best;
      } else {
        break;
      }
    }
  }

  private less(i: number, j: number) {
    const a = this.heap[i]!;
    const b = this.heap[j]!;
    if (a.priority !== b.priority) return a.priority < b.priority; // smaller number = higher priority
    return a.enqueuedAt_ms < b.enqueuedAt_ms; // FIFO within same priority
  }

  private swap(i: number, j: number) {
    const tmp = this.heap[i]!;
    this.heap[i] = this.heap[j]!;
    this.heap[j] = tmp;
  }

  private findLowestPriorityIndex(): number {
    let idx = 0;
    for (let i = 1; i < this.heap.length; i++) {
      const a = this.heap[i]!;
      const b = this.heap[idx]!;
      if (a.priority > b.priority) idx = i;
      else if (a.priority === b.priority && a.enqueuedAt_ms > b.enqueuedAt_ms) idx = i;
    }
    return idx;
  }

  private removeAt(i: number) {
    const last = this.heap.pop()!;
    if (i >= this.heap.length) return;
    this.heap[i] = last;
    this.siftDown(i);
    this.siftUp(i);
  }
}

