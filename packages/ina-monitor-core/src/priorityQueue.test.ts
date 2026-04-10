import assert from "node:assert/strict";
import test from "node:test";
import { PriorityQueue } from "./priorityQueue.js";

test("PriorityQueue: lower number = higher priority", () => {
  const q = new PriorityQueue<string>({ capacity: 10 });
  assert.equal(q.enqueue(1, "b").accepted, true);
  assert.equal(q.enqueue(0, "a").accepted, true);
  const first = q.dequeue();
  assert.equal(first?.value, "a");
});
