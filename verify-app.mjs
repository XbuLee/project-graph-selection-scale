import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { decode } from "@msgpack/msgpack";
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";

const label = process.argv[2];
if (!["half", "original", "double", "reopened"].includes(label)) throw new Error("需要 half/original/double/reopened 参数");
const path = new URL("dist/选区缩放示例.prg", import.meta.url);
const reader = new ZipReader(new Uint8ArrayReader(await readFile(path)));
let stage;
try {
  const entry = (await reader.getEntries()).find((item) => item.filename === "stage.msgpack");
  stage = decode(await entry.getData(new Uint8ArrayWriter()));
} finally { await reader.close(); }
const nodes = stage.filter((item) => item._ === "TextNode").map((item) => ({
  id: item.uuid, level: item.fontScaleLevel, rect: item.collisionBox.shapes[0],
}));
assert.equal(nodes.length, 3);
const arc = stage.find((item) => item._ === "ArcEdge");
const factor = label === "half" || label === "reopened" ? .5 : label === "double" ? 2 : 1;
assert.ok(nodes.every((node) => node.level === 2 * Math.log2(factor)));
assert.equal(arc.offset, 100 * factor);
assert.ok(Math.abs(nodes[1].rect.location.x - nodes[0].rect.location.x - 400 * factor) < .02);
assert.ok(Math.abs(nodes[2].rect.location.y - nodes[1].rect.location.y - 240 * factor) < .02);
const report = { label, factor, nodes, arcOffset: arc.offset, stageObjectCount: stage.length };
await mkdir(new URL("qa/", import.meta.url), { recursive: true });
if (label === "reopened") {
  const before = JSON.parse(await readFile(new URL("qa/half.json", import.meta.url), "utf8"));
  assert.deepEqual(report.nodes, before.nodes);
  assert.equal(report.arcOffset, before.arcOffset);
}
await writeFile(new URL(`qa/${label}.json`, import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(`${label}: 已验证应用保存的 3 个字号、节点间距和圆弧偏移，比例 ${factor}`);
