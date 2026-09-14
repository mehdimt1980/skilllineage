import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { readShard } from "./reader.js";
import type { ShardReadEvent } from "./reader.js";
import type { IndexShard } from "./types.js";

const tempDirs: string[] = [];

async function makeExactShard(data: IndexShard): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skilllineage-reader-profile-"));
  tempDirs.push(dir);
  const exactDir = path.join(dir, "exact");
  await mkdir(exactDir, { recursive: true });
  await writeFile(
    path.join(exactDir, "ab.json.gz"),
    gzipSync(Buffer.from(JSON.stringify(data), "utf-8")),
  );
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("reader profiling observer", () => {
  it("reports byte sizes and all non-negative timing fields without changing parsing", async () => {
    const shard: IndexShard = {
      abcd: { copyCount: 0, occurrences: [] },
    };
    const dir = await makeExactShard(shard);
    const events: ShardReadEvent[] = [];

    const profiled = await readShard(dir, "ab", (event) => events.push(event));
    const ordinary = await readShard(dir, "ab");

    expect(profiled).toEqual(shard);
    expect(ordinary).toEqual(shard);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ shardKind: "exact", prefix: "ab" });
    expect(events[0].compressedBytes).toBeGreaterThan(0);
    expect(events[0].decompressedBytes).toBeGreaterThan(0);
    expect(events[0].readMs).toBeGreaterThanOrEqual(0);
    expect(events[0].gunzipMs).toBeGreaterThanOrEqual(0);
    expect(events[0].parseMs).toBeGreaterThanOrEqual(0);
    expect(events[0].totalMs).toBeGreaterThanOrEqual(0);
  });
});
