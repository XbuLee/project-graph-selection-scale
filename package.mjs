import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { encode, decode } from "@msgpack/msgpack";
import { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${manifest.version}`) {
  throw new Error(`发布标签 ${process.env.RELEASE_TAG} 与插件版本 v${manifest.version} 不一致`);
}
const metadata = { version: "2.0.0", extension: {
  id: manifest.name, name: manifest.displayName, version: manifest.version,
  description: manifest.description, author: manifest.author,
} };
await writeFile(join(root, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
await writeFile(join(root, "metadata.msgpack"), encode(metadata));
await mkdir(join(root, "dist"), { recursive: true });
const files = ["metadata.msgpack", "extension.js", "README.md", "LICENSE"];
// macOS 的解压工具需要未压缩条目的大小和校验值写在文件头内。
const zipOptions = { level: 0, dataDescriptor: false };
const archive = new ZipWriter(new Uint8ArrayWriter(), zipOptions);
for (const name of files) await archive.add(name, new Uint8ArrayReader(await readFile(join(root, name))));
const output = join(root, "dist", `${manifest.name}.prg`);
await writeFile(output, await archive.close());
await copyFile(output, join(root, "dist", `${manifest.name}-v${manifest.version}.prg`));
const reader = new ZipReader(new Uint8ArrayReader(await readFile(output)));
try {
  const entries = await reader.getEntries();
  if (entries.length !== files.length || entries.some((item) => !files.includes(item.filename))) throw new Error("扩展包结构不正确");
  const entry = entries.find((item) => item.filename === "metadata.msgpack");
  if (decode(await entry.getData(new Uint8ArrayWriter())).extension.id !== manifest.name) throw new Error("元数据不匹配");
} finally { await reader.close(); }

const vector = (x, y) => ({ _: "Vector", x, y });
const color = { _: "Color", r: 0, g: 0, b: 0, a: 0 };
const node = (uuid, text, x, y) => ({
  _: "TextNode", uuid, text, fontScaleLevel: 0, sizeAdjust: "auto", color,
  collisionBox: { _: "CollisionBox", shapes: [{ _: "Rectangle", location: vector(x, y), size: vector(160, 76) }] },
  details: [], fontFamily: "", fontWeight: "", borderStyle: "solid",
});
const stage = [node("scale-example-a", "节点 A", 0, 0), node("scale-example-b", "节点 B", 400, 0), node("scale-example-c", "节点 C", 400, 240)];
stage.push({
  _: "LineEdge", uuid: "scale-example-line", associationList: [{ $: "/0" }, { $: "/1" }],
  text: "连线", color, sourceRectangleRate: vector(.99, .5), targetRectangleRate: vector(.01, .5), lineType: "solid", arrowType: "default",
});
stage.push({
  _: "ArcEdge", uuid: "scale-example-arc", associationList: [{ $: "/1" }, { $: "/2" }],
  text: "圆弧", color, sourceRectangleRate: vector(.5, .99), targetRectangleRate: vector(.5, .01), lineType: "solid", arrowType: "default", offset: 100, textPosition: .5,
});
const sample = new ZipWriter(new Uint8ArrayWriter(), zipOptions);
for (const [name, data] of Object.entries({ "metadata.msgpack": { version: "2.7.0" }, "stage.msgpack": stage, "tags.msgpack": [], "reference.msgpack": { sections: {}, files: [] } })) {
  await sample.add(name, new Uint8ArrayReader(encode(data)));
}
const sampleBytes = await sample.close();
const samplePath = join(root, "dist", "选区缩放示例.prg");
try {
  await writeFile(samplePath, sampleBytes, { flag: "wx" });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("保留已有示例图；分享包使用新生成的原始示例。");
}

const share = new ZipWriter(new Uint8ArrayWriter(), zipOptions);
await share.add(`${manifest.name}.prg`, new Uint8ArrayReader(await readFile(output)));
await share.add("选区缩放示例.prg", new Uint8ArrayReader(sampleBytes));
await share.add("使用说明.md", new Uint8ArrayReader(await readFile(join(root, "SHARE.md"))));
for (const name of ["README.md", "LICENSE"]) {
  await share.add(name, new Uint8ArrayReader(await readFile(join(root, name))));
}
const sharePath = join(root, "dist", `选区等比缩放-v${manifest.version}-分享包.zip`);
await writeFile(sharePath, await share.close());

const source = new ZipWriter(new Uint8ArrayWriter(), zipOptions);
for (const name of [
  ".gitignore", ".github/workflows/release.yml", "package.json", "package-lock.json",
  "package.mjs", "test.mjs", "verify-app.mjs", "metadata.json", "SHARE.md",
  "PUBLISHING.md", "CHANGELOG.md", "VALIDATION.md",
  "qa/half.json", "qa/original.json", "qa/double.json", "qa/reopened.json", ...files,
]) {
  await source.add(name, new Uint8ArrayReader(await readFile(join(root, name))));
}
const sourcePath = join(root, "dist", `selection-scale-v${manifest.version}-source.zip`);
await writeFile(sourcePath, await source.close());
console.log(`已校验安装包：${output}`);
console.log(`示例图：${samplePath}`);
console.log(`分享包：${sharePath}`);
console.log(`源码包：${sourcePath}`);
