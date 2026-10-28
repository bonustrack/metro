export class Flights<T> {
  private readonly running = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const held = this.running.get(key);
    if (held !== undefined) return held;
    const flight = work().finally(() => {
      this.running.delete(key);
    });
    this.running.set(key, flight);
    return flight;
  }
}
