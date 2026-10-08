#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const exec = promisify(execFile);
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "benchmark-summary.mjs");
const tmp = await mkdtemp(path.join(tmpdir(), "skilllineage-aggregate-test-"));
const categories = ["exact","sameInstructions","variantLight","variantMedium","none"];
function fixture() {
  const latencyMs={};
  for (const name of categories) latencyMs[name]={count:3,p50:10,p95:20,max:30,raw:[10,20,30]};
  return {
    schemaVersion:"0.2",
    dataset:{sourceDbBytes:20000,requestedSampleCount:3,sampleCount:3,seed:42,
      sampleIdentifiers:[{repoFullName:"SENSITIVE_OWNER/SENSITIVE_REPO",path:"SENSITIVE_SKILL_PATH"}]},
    index:{totalBytes:8000,categories:{secret:"SENSITIVE_INDEX_PATH"}},
    environment:{node:"v24.0.0",python:"3.13.0",nodePlatform:"win32-x64",platform:"SENSITIVE_HOST"},
    quality:{exactHitRate:1,sameInstructionsHitRate:1,none:{noneRate:1},
      variantLight:{recallAt1:.6,recallAt3:.7,recallAt10:.9,
        groundTruthAtLeast070:{count:2,recallAt10:.5}},
      variantMedium:{recallAt1:.3,recallAt3:.4,recallAt10:.5,
        groundTruthAtLeast070:{count:1,recallAt10:1}}},
    latencyMs,slowQueries:[{url:"SENSITIVE_QUERY"}]
  };
}
async function run(input,out) {
  return exec(process.execPath,[script,input,out],{timeout:15000});
}
async function shouldFail(input,out) {
  let failure;
  try { await run(input,out); } catch(e) { failure=e; }
  assert(failure,"Expected non-zero result");
  assert.notEqual(failure.code,0);
}
try {
  const rawFile=path.join(tmp,"private.json");
  const out=path.join(tmp,"safe.json");
  const data=fixture();
  await writeFile(rawFile,JSON.stringify(data));
  await run(rawFile,out);
  const safe=await readFile(out,"utf8");
  const obj=JSON.parse(safe);
  assert.equal(obj.format,"skilllineage-aggregate-benchmark-v1");
  assert.equal(obj.dataset.sampleCount,3);
  assert.equal(obj.quality.variantRecall.light.recallAt10,.9);
  assert.equal(obj.latency.variantMedium.p95Ms,20);
  for(const text of ["SENSITIVE","sampleIdentifiers","slowQueries",'"raw"', "SENSITIVE_HOST"])
    assert(!safe.includes(text),"Leaked raw report material: "+text);
  await shouldFail(rawFile,out); // refuse overwrite
  data.quality.variantLight.recallAt3=.1; // non-monotonic
  const bad=path.join(tmp,"bad.json");
  await writeFile(bad,JSON.stringify(data));
  await shouldFail(bad,path.join(tmp,"bad-out.json"));
  data.quality.variantLight.recallAt3=.7;
  data.latencyMs.exact.count=2;
  await writeFile(bad,JSON.stringify(data));
  await shouldFail(bad,path.join(tmp,"bad-out2.json"));
  data.latencyMs.exact.count=3;
  data.schemaVersion="0.1";
  await writeFile(bad,JSON.stringify(data));
  await shouldFail(bad,path.join(tmp,"bad-out3.json"));

  const runner=path.join(path.dirname(script),"run-realdata-validation.mjs");
  let err;
  try {
    await exec(process.execPath,[runner,"--db","missing.db","--index","missing-index",
      "--integrity","missing-sidecar","--out",path.join(tmp,"nonexistent")],
      {timeout:15000});
  }catch(e){err=e;}
  assert(err,"Real-data runner must fail closed on missing sources");
  console.log("PASS: aggregate-only report, schema/metric guards, overwrite refusal, source path failures");
} finally {
  await rm(tmp,{recursive:true,force:true});
}
