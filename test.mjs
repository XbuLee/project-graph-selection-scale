import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MessageChannel as NativeMessageChannel } from "node:worker_threads";
import * as Comlink from "comlink";
import test from "node:test";

const code = await readFile(new URL("extension.js", import.meta.url), "utf8");
class Host {}
class Bounds extends Host {
  constructor(x, y, width, height) { super(); Object.assign(this, { left: x, top: y, width, height }); }
}
class Box extends Host {
  constructor(r) { super(); this.r = r; }
  getRectangle() { return this.r; }
}
function decode(value) {
  if (value?._ === "CollisionBox") {
    const r = value.shapes[0];
    return new Box(new Bounds(r.location.x, r.location.y, r.size.x, r.size.y));
  }
  return value;
}
class Node extends Host {
  constructor(id, kind = "text", r = [0, 0, 200, 76], extra = {}) {
    super();
    Object.assign(this, { uuid: id, kind, isSelected: true, isEditing: false, fontScaleLevel: 0, sizeAdjust: "auto", text: id, state: "success", scale: 1, parentSection: null, children: [], locked: false }, extra);
    this.collisionBox = new Box(new Bounds(...r));
  }
  get collisionBox() { return this._box; }
  set collisionBox(value) { this._box = decode(value); }
  getFontSize() { return Math.floor(32 * 2 ** (this.fontScaleLevel / 2)); }
  getPadding() { return this.getFontSize() / 32 * 14; }
  setFontScaleLevel(level) {
    if (this.failOnce) { this.failOnce = false; throw new Error("模拟宿主异常"); }
    const ratio = Math.floor(32 * 2 ** (level / 2)) / this.getFontSize();
    const old = this.collisionBox.getRectangle();
    this.fontScaleLevel = level;
    // 模拟原生字号修改时会重算碰撞箱；插件必须在其后还原等比矩形。
    this.collisionBox = new Box(new Bounds(999, 999, old.width * ratio, old.height * ratio));
  }
}
class Edge extends Host {
  constructor(source, target, offset = 0) { super(); Object.assign(this, { source, target, offset }); }
}
const bounds = (node) => {
  const r = node.collisionBox.getRectangle();
  return [r.left, r.top, r.width, r.height];
};
const near = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-7, `${value} != ${expected[i]}`));
};

async function harness(nodes, options = {}) {
  const callbacks = new Map();
  const errors = [];
  const successes = [];
  const settings = {};
  const history = [];
  const arcs = options.arcs ?? [];
  const crEdges = options.crEdges ?? [];
  const project = Object.assign(new Host(), {
    uri: Object.assign(new Host(), { toString: () => "file:///selection-scale-test.prg" }),
    collaboration: Object.assign(new Host(), { isActive: !!options.readOnly, canEdit: !options.readOnly }),
    textRenderer: Object.assign(new Host(), {
      measureMultiLineTextSize: (text, font, width, height) => Object.assign(new Host(), { y: Math.max(1, Math.ceil(text.length * font * .6 / width)) * font * height }),
    }),
    stageManager: Object.assign(new Host(), {
      getSelectedEntities: () => nodes.filter((node) => node.isSelected),
      getTextNodes: () => nodes.filter((node) => node.kind === "text"),
      getSections: () => nodes.filter((node) => node.kind === "section"),
      getImageNodes: () => nodes.filter((node) => node.kind === "image"),
      getSvgNodes: () => nodes.filter((node) => node.kind === "svg"),
      getLatexNodes: () => nodes.filter((node) => node.kind === "latex"),
      getConnectPoints: () => nodes.filter((node) => node.kind === "point"),
      getArcEdges: () => arcs,
      getCrEdges: () => crEdges,
      updateReferences() {},
    }),
    historyManager: Object.assign(new Host(), {
      recordStep() { history.push(nodes.map((node) => ({ r: bounds(node), level: node.fontScaleLevel, scale: node.scale, mode: node.sizeAdjust }))); },
    }),
  });
  let switched = false;
  const prg = {
    tabs_getCurrentProject: () => options.noProject || switched ? null : project,
    settings_getOwn: (key) => settings[key],
    settings_setOwn: (key, value) => { settings[key] = value; },
    dialog_input: () => { options.onDialog?.(nodes); switched = !!options.switchProject; return "input" in options ? options.input : "50"; },
    keybinds_register: (id, icon, keys, callback) => { callbacks.set(id, callback); },
    toast_error: (message) => errors.push(message),
    toast_success: (message) => successes.push(message),
  };
  const bridge = options.bridge ? options.bridge(prg) : { prg, Comlink: { proxy: (value) => value } };
  await new Function("prg", "Comlink", `return ${code}`)(bridge.prg, bridge.Comlink);
  assert.equal(errors.length, 0, "startup");
  return { project, errors, successes, settings, history, run: (name = "输入缩放比例") => callbacks.get(name)() };
}

test("half scale keeps a common center, every gap and straight-line endpoint proportional", async () => {
  const a = new Node("a", "text", [0, 0, 200, 76]);
  const b = new Node("b", "text", [400, 200, 200, 76]);
  const outside = new Node("outside", "text", [1000, 1000, 200, 76], { isSelected: false });
  const externalEdge = new Edge(a, outside);
  const app = await harness([a, b, outside]);
  await app.run();
  assert.deepEqual(app.errors, []);
  near(bounds(a), [150, 69, 100, 38]);
  near(bounds(b), [350, 169, 100, 38]);
  near(bounds(outside), [1000, 1000, 200, 76]);
  assert.equal(a.getFontSize(), 16);
  assert.equal(b.getFontSize(), 16);
  assert.equal(externalEdge.source, a);
  assert.equal(externalEdge.target, outside);
  assert.equal(app.history.length, 2);
  assert.equal(app.settings.lastPercent, 50);
});

test("shrink then enlarge restores sizes, positions, fonts, manual wrapping and arc shape", async () => {
  const a = new Node("a", "text", [20, 30, 220, 172], { sizeAdjust: "manual", text: "manual ".repeat(3) });
  const b = new Node("b", "text", [700, 100, 280, 76]);
  const arc = new Edge(a, b, -180);
  const exteriorArc = new Edge(a, new Node("outside"), 300);
  const app = await harness([a, b], { arcs: [arc, exteriorArc] });
  await app.run("缩小至一半");
  assert.equal(arc.offset, -90);
  assert.equal(exteriorArc.offset, 300);
  await app.run("放大至两倍");
  assert.deepEqual(app.errors, []);
  near(bounds(a), [20, 30, 220, 172]);
  near(bounds(b), [700, 100, 280, 76]);
  assert.equal(a.getFontSize(), 32);
  assert.equal(a.sizeAdjust, "manual");
  assert.equal(arc.offset, -180);
});

test("nested selected groups and their separately selected children scale exactly once", async () => {
  const a = new Node("a", "text", [0, 0, 200, 76]);
  const b = new Node("b", "text", [400, 200, 200, 76], { isSelected: false });
  const inner = new Node("inner", "section", [370, 120, 260, 186], { children: [b], isSelected: false });
  const outer = new Node("outer", "section", [-30, -80, 700, 400], { children: [a, inner] });
  a.parentSection = outer;
  b.parentSection = inner;
  inner.parentSection = outer;
  const app = await harness([a, b, inner, outer]);
  await app.run();
  assert.deepEqual(app.errors, []);
  near(bounds(a), [150, 69, 100, 38]);
  near(bounds(b), [350, 169, 100, 38]);
  assert.equal(b.isSelected, false);
  assert.equal(outer.children[0], a);
});

test("images and formula sizes scale; routing points move by their centers", async () => {
  const image = new Node("image", "image", [0, 0, 400, 200]);
  const svg = new Node("svg", "svg", [500, 0, 100, 100]);
  const formula = new Node("formula", "latex", [0, 300, 200, 100]);
  const point = new Node("point", "point", [700, 300, 30, 30]);
  const app = await harness([image, svg, formula, point]);
  await app.run();
  assert.deepEqual(app.errors, []);
  assert.equal(image.scale, .5);
  assert.equal(svg.scale, .5);
  assert.equal(formula.fontScaleLevel, -2);
  near(bounds(point), [525, 242.5, 30, 30]);
});

for (const [name, input] of [["zero", "0"], ["negative", "-5"], ["NaN", "hello"], ["empty", ""], ["infinity", "Infinity"], ["overflow", "1001"], ["hex", "0x32"]]) {
  test(`invalid ${name} leaves the diagram and history untouched`, async () => {
    const node = new Node("a");
    const app = await harness([node], { input });
    await app.run();
    assert.equal(app.errors.length, 1);
    near(bounds(node), [0, 0, 200, 76]);
    assert.equal(app.history.length, 0);
  });
}

for (const input of [undefined, null, "100", "100%", "100％"]) {
  test(`cancel or 100 percent creates no history (${String(input)})`, async () => {
    const app = await harness([new Node("a")], { input });
    await app.run();
    assert.deepEqual(app.errors, []);
    assert.equal(app.history.length, 0);
  });
}

test("custom percent is stable under the native two-decimal level serialization", async () => {
  const node = new Node("a");
  const app = await harness([node], { input: "125%" });
  await app.run();
  assert.deepEqual(app.errors, []);
  assert.equal(node.getFontSize(), 40);
  const before = node.getFontSize();
  node.fontScaleLevel = Number(node.fontScaleLevel.toFixed(2));
  assert.equal(node.getFontSize(), before);
  near(bounds(node), [-25, -9.5, 250, 95]);
});

test("a host failure rolls all changed nodes back before reporting it", async () => {
  const a = new Node("a");
  const b = new Node("b", "text", [400, 200, 200, 76], { failOnce: true });
  const app = await harness([a, b]);
  await app.run();
  assert.equal(app.errors.length, 1);
  assert.match(app.errors[0], /已恢复原布局/);
  near(bounds(a), [0, 0, 200, 76]);
  near(bounds(b), [400, 200, 200, 76]);
  assert.equal(a.fontScaleLevel, 0);
  assert.equal(b.fontScaleLevel, 0);
  assert.equal(app.successes.length, 0);
});

for (const [name, make, options] of [
  ["unsupported node", () => [new Node("url", "url")], {}],
  ["locked group", () => [new Node("section", "section", undefined, { locked: true })], {}],
  ["locked ancestor", () => [new Node("a", "text", undefined, { parentSection: new Node("section", "section", undefined, { locked: true }) })], {}],
  ["active editing", () => [new Node("a", "text", undefined, { isEditing: true })], {}],
  ["manual minimum width", () => [new Node("a", "text", [0, 0, 100, 76], { sizeAdjust: "manual" })], {}],
  ["unloaded image", () => [new Node("a", "image", undefined, { state: "loading" })], {}],
  ["no selection", () => [new Node("a", "text", undefined, { isSelected: false })], {}],
  ["read only", () => [new Node("a")], { readOnly: true }],
  ["project switched", () => [new Node("a")], { switchProject: true }],
  ["selection changed", () => [new Node("a")], { onDialog: (nodes) => { nodes[0].isSelected = false; } }],
]) {
  test(`${name} fails before any mutation`, async () => {
    const app = await harness(make(), options);
    await app.run();
    assert.equal(app.errors.length, 1);
    assert.equal(app.history.length, 0);
  });
}

test("real Comlink messages preserve host objects, serialized geometry and rollback", async () => {
  const channels = [];
  const previousChannel = globalThis.MessageChannel;
  const originalHandlers = new Map(Comlink.transferHandlers);
  globalThis.MessageChannel = class extends NativeMessageChannel {
    constructor() { super(); channels.push(this); }
  };
  const proxyHandler = Comlink.transferHandlers.get("proxy");
  Comlink.transferHandlers.set("TEST_HOST_OBJECTS", {
    canHandle: (v) => v instanceof Host || Array.isArray(v),
    serialize(v) {
      const values = Array.isArray(v) ? v : [v];
      const encoded = values.map((item) => proxyHandler.serialize(Comlink.proxy(item)));
      return [{ array: Array.isArray(v), ports: encoded.map(([port]) => port) }, encoded.flatMap(([, ports]) => ports)];
    },
    deserialize(v) { const values = v.ports.map((port) => proxyHandler.deserialize(port)); return v.array ? values : values[0]; },
  });
  Comlink.transferHandlers.set("CUSTOM_TYPES", {
    canHandle: (v) => v !== null && typeof v === "object" && typeof v._ === "string",
    serialize: (v) => [v, []], deserialize: decode,
  });
  function bridge(prg) {
    const channel = new globalThis.MessageChannel();
    Comlink.expose(prg, channel.port1);
    return { prg: Comlink.wrap(channel.port2), Comlink };
  }
  try {
    const a = new Node("a");
    const b = new Node("b", "text", [400, 200, 200, 76]);
    const app = await harness([a, b], { bridge });
    await app.run();
    assert.deepEqual(app.errors, []);
    near(bounds(a), [150, 69, 100, 38]);
    assert.equal(a.fontScaleLevel, -2);
    const failed = await harness([new Node("x"), new Node("y", "text", undefined, { failOnce: true })], { bridge });
    await failed.run();
    assert.match(failed.errors[0], /已恢复原布局/);
  } finally {
    for (const { port1, port2 } of channels) { port1.close(); port2.close(); }
    Comlink.transferHandlers.clear();
    for (const [key, value] of originalHandlers) Comlink.transferHandlers.set(key, value);
    globalThis.MessageChannel = previousChannel;
  }
});
