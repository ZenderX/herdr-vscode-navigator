import assert from "node:assert/strict";
import { createConfigQueue } from "../../../vscode/configQueue";

describe("createConfigQueue", () => {
  it("never lets two writes overlap, retries a rejection the given count while holding the queue, then rejects without stalling later writes", async () => {
    let delays = 0;
    const queue = createConfigQueue({ delay: async () => void delays++ });

    // Overlapping configuration writes are what the queue exists to stop: the second must not start until the first settles.
    const order: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => {
      order.push("first start");
      await gate;
      order.push("first end");
      return 1;
    });
    const second = queue.run(async () => {
      order.push("second");
      return 2;
    });
    await new Promise(setImmediate);
    assert.deepEqual(order, ["first start"]);
    release();
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(order, ["first start", "first end", "second"]);
    assert.equal(delays, 0);

    let attempts = 0;
    const failure = new Error("write rejected");
    const rejected = queue.run(async () => {
      attempts++;
      throw failure;
    }, 3);
    const after: string[] = [];
    const later = queue.run(async () => {
      after.push(`after ${attempts} attempts`);
      return "written";
    });
    await assert.rejects(rejected, (err: unknown) => err === failure);
    assert.equal(attempts, 4);
    assert.equal(delays, 3);
    assert.equal(await later, "written");
    assert.deepEqual(after, ["after 4 attempts"]);

    let flaky = 0;
    const recovered = await queue.run(async () => {
      flaky++;
      if (flaky < 3) throw new Error("not yet");
      return "ok";
    }, 3);
    assert.equal(recovered, "ok");
    assert.equal(flaky, 3);

    let once = 0;
    await assert.rejects(
      queue.run(async () => {
        once++;
        throw failure;
      }),
      (err: unknown) => err === failure,
    );
    assert.equal(once, 1);
  });
});
