/** Fixed-capacity FIFO that drops the oldest entry when full. */
export class RingBuffer<T> {
  private items: T[] = [];
  constructor(
    readonly capacity: number,
    private onEvict?: (item: T) => void,
  ) {}
  push(item: T) {
    this.items.push(item);
    while (this.items.length > this.capacity) {
      const old = this.items.shift()!;
      this.onEvict?.(old);
    }
  }
  toArray(): T[] {
    return this.items.slice();
  }
  get size() {
    return this.items.length;
  }
  clear() {
    this.items = [];
  }
}
