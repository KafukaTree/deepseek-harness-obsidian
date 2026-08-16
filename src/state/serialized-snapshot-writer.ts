export class SerializedSnapshotWriter<T> {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly write: (snapshot: T) => Promise<void>) {}

  save(value: T): Promise<void> {
    const snapshot = structuredClone(value);
    const task = this.tail
      .catch(() => undefined)
      .then(() => this.write(snapshot));
    this.tail = task;
    return task;
  }
}
