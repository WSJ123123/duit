// fake-indexeddb is scoped to this file (do not add to vitest.setup.ts):
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueue, peekAll, remove, flushQueue, type QueuedEntry } from "@/lib/offline-queue";
import type { TxInput } from "@/lib/transactions";

function makeEntry(n: number): QueuedEntry {
  const input: TxInput = {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    type: "expense",
    amount: `${n}.00`,
    accountId: "acc-1",
    date: "2026-08-16",
    note: `entry ${n}`,
    source: "nl",
    needsReview: false,
  };
  return { id: input.id!, input, queuedAt: `2026-08-16T00:00:0${n}Z` };
}

beforeEach(() => {
  // Fresh IndexedDB per test — the queue opens a connection per operation,
  // so swapping the factory fully resets state.
  globalThis.indexedDB = new IDBFactory();
});

describe("offline queue", () => {
  it("enqueue then peekAll returns entries in FIFO order", async () => {
    const e1 = makeEntry(1);
    const e2 = makeEntry(2);
    const e3 = makeEntry(3);
    await enqueue(e1);
    await enqueue(e2);
    await enqueue(e3);
    const all = await peekAll();
    expect(all.map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
    expect(all[0]?.input.note).toBe("entry 1");
  });

  it("remove deletes exactly one entry", async () => {
    const e1 = makeEntry(1);
    const e2 = makeEntry(2);
    await enqueue(e1);
    await enqueue(e2);
    await remove(e1.id);
    const all = await peekAll();
    expect(all.map((e) => e.id)).toEqual([e2.id]);
  });

  it("flushQueue with an always-ok sender empties the queue and reports counts", async () => {
    await enqueue(makeEntry(1));
    await enqueue(makeEntry(2));
    const send = vi.fn(async () => ({ ok: true }));
    const result = await flushQueue(send);
    expect(result).toEqual({ sent: 2, remaining: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await peekAll()).toEqual([]);
  });

  it("flushQueue sends in FIFO order", async () => {
    await enqueue(makeEntry(3));
    await enqueue(makeEntry(1));
    await enqueue(makeEntry(2));
    const seen: string[] = [];
    await flushQueue(async (input) => {
      seen.push(input.note ?? "");
      return { ok: true };
    });
    expect(seen).toEqual(["entry 3", "entry 1", "entry 2"]);
  });

  it("flushQueue stops at the first failure, keeping the failed entry and all after it", async () => {
    const e1 = makeEntry(1);
    const e2 = makeEntry(2);
    const e3 = makeEntry(3);
    await enqueue(e1);
    await enqueue(e2);
    await enqueue(e3);
    let calls = 0;
    const result = await flushQueue(async () => {
      calls += 1;
      return { ok: calls !== 2 };
    });
    expect(result).toEqual({ sent: 1, remaining: 2 });
    expect(calls).toBe(2); // never reaches entry 3
    const left = await peekAll();
    expect(left.map((e) => e.id)).toEqual([e2.id, e3.id]);
  });

  it("flushQueue treats a thrown send (network failure) like a failure", async () => {
    await enqueue(makeEntry(1));
    await enqueue(makeEntry(2));
    const result = await flushQueue(async () => {
      throw new Error("network down");
    });
    expect(result).toEqual({ sent: 0, remaining: 2 });
    expect((await peekAll()).length).toBe(2);
  });

  it("double-flush after success is a no-op", async () => {
    await enqueue(makeEntry(1));
    const send = vi.fn(async () => ({ ok: true }));
    await flushQueue(send);
    const second = await flushQueue(send);
    expect(second).toEqual({ sent: 0, remaining: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
