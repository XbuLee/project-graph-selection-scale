(async () => {
  let running = false;
  const vector = (x, y) => ({ _: "Vector", x, y });
  const box = (r) => ({
    _: "CollisionBox",
    shapes: [{ _: "Rectangle", location: vector(r.x, r.y), size: vector(r.w, r.h) }],
  });
  const errorText = (error) => error instanceof Error ? error.message : String(error);

  async function set(object, key, value) {
    object[key] = value;
    // Comlink 的属性赋值是异步消息；在同一代理上读取，等待前面的赋值完成。
    await object[key];
  }

  async function rect(node) {
    const r = await (await node.collisionBox).getRectangle();
    const result = { x: await r.left, y: await r.top, w: await r.width, h: await r.height };
    if (!Object.values(result).every(Number.isFinite) || result.w < 0 || result.h < 0) {
      throw new Error("选区中有尺寸尚未加载完成的节点，请稍后重试。");
    }
    return result;
  }

  async function identity(project) {
    return (await project.uri).toString();
  }

  async function selectionIds(manager) {
    return Promise.all((await manager.getSelectedEntities()).map(async (node) => await node.uuid));
  }

  function percent(input) {
    const text = String(input).trim().replace(/[％%]$/, "").trim();
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error("请输入 10–1000 之间的百分比，例如 50 或 125%。");
    const value = Number(text);
    if (!Number.isFinite(value) || value < 10 || value > 1000) throw new Error("缩放比例需要在 10% 到 1000% 之间。");
    return value / 100;
  }

  async function collect(manager, ids) {
    const groups = [
      ["text", await manager.getTextNodes()],
      ["section", await manager.getSections()],
      ["image", await manager.getImageNodes()],
      ["svg", await manager.getSvgNodes()],
      ["latex", await manager.getLatexNodes()],
      ["point", await manager.getConnectPoints()],
    ];
    const known = new Map();
    for (const [kind, nodes] of groups) {
      for (const node of nodes) known.set(await node.uuid, { kind, node });
    }
    const result = new Map();
    async function visit(id, visiting = new Set()) {
      if (visiting.has(id)) throw new Error("分组框存在循环嵌套，请先整理分组。");
      if (result.has(id)) return;
      const item = known.get(id);
      if (!item) throw new Error("选区含暂不支持的节点。请只选文本、图片、SVG、公式、质点或由它们组成的分组。");
      if (await item.node.isEditing || await item.node.isEditingTitle) throw new Error("请先结束文字编辑，再缩放选区。");
      result.set(id, { ...item, id });
      if (item.kind === "section") {
        if (await item.node.locked) throw new Error("选区中有锁定的分组框，请先解锁。");
        const ancestors = new Set([...visiting, id]);
        for (const child of await item.node.children) await visit(await child.uuid, ancestors);
      }
    }
    for (const id of ids) await visit(id);
    // 同时检查未被选中的祖先；不能借助插件修改锁定分组中的子节点。
    for (const { node } of result.values()) {
      let parent = await node.parentSection;
      const seen = new Set();
      while (parent) {
        const id = await parent.uuid;
        if (seen.has(id)) throw new Error("分组框存在循环嵌套，请先整理分组。");
        seen.add(id);
        if (await parent.locked) throw new Error("节点位于锁定的分组框内，请先解锁。");
        parent = await parent.parentSection;
      }
    }
    return result;
  }

  async function snapshot(item) {
    const { kind, node } = item;
    const result = { ...item, before: await rect(node) };
    if (kind === "text") {
      result.level = await node.fontScaleLevel;
      result.mode = await node.sizeAdjust;
      result.font = await node.getFontSize();
      result.text = await node.text;
    } else if (kind === "latex") {
      result.level = await node.fontScaleLevel;
    } else if (kind === "image" || kind === "svg") {
      result.scale = await node.scale;
      if (kind === "image" && await node.state !== "success") throw new Error("请等待图片加载完成后再缩放。");
    }
    return result;
  }

  function plan(items, factor) {
    const leaves = items.filter((item) => item.kind !== "section");
    if (!leaves.length) throw new Error("选中的分组框没有可缩放的节点。");
    const left = Math.min(...leaves.map((item) => item.before.x));
    const top = Math.min(...leaves.map((item) => item.before.y));
    const right = Math.max(...leaves.map((item) => item.before.x + item.before.w));
    const bottom = Math.max(...leaves.map((item) => item.before.y + item.before.h));
    const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
    let rounded = false;
    for (const item of leaves) {
      const r = item.before;
      item.after = { x: center.x + (r.x - center.x) * factor, y: center.y + (r.y - center.y) * factor, w: r.w * factor, h: r.h * factor };
      if (item.kind === "point") {
        // 原生质点半径固定；它只作为折线拐点移动，不能修改半径后在取消选中时跳回。
        item.after.x += (item.after.w - r.w) / 2;
        item.after.y += (item.after.h - r.h) / 2;
        item.after.w = r.w;
        item.after.h = r.h;
      }
      if (!Object.values(item.after).every(Number.isFinite) || Math.max(...Object.values(item.after).map(Math.abs)) > 1e9) {
        throw new Error("缩放后的坐标或尺寸过大，请使用较小的比例。");
      }
      if (item.kind === "text" || item.kind === "latex") {
        // 原生序列化只保存两位小数，提前按同样精度量化，防止重开后字号变化。
        item.nextLevel = Math.round((item.level + 2 * Math.log2(factor)) * 100) / 100;
        if (!Number.isFinite(item.nextLevel) || item.nextLevel < -8 || item.nextLevel > 12) throw new Error("缩放后的字号超出支持范围，请调整比例。");
      }
      if (item.kind === "text") {
        const requestedFont = item.font * factor;
        item.nextLevel = Math.ceil(2 * Math.log2(Math.max(2, Math.round(requestedFont)) / 32) * 100 - 1e-9) / 100;
        if (item.mode === "manual" && item.after.w < 75 - 1e-7) {
          throw new Error(`“${item.text.slice(0, 18)}”启用了手动换行，原生最小宽度为 75。请使用至少 ${Math.ceil(7500 / r.w)}% 的比例，或先切换为自动宽度。`);
        }
        rounded ||= Math.abs(requestedFont - Math.floor(32 * 2 ** (item.nextLevel / 2))) > 1e-7;
      }
      if (item.scale !== undefined && (!Number.isFinite(item.scale * factor) || item.scale * factor < 0.1 || item.scale * factor > 10)) {
        throw new Error("缩放后图片或 SVG 的原图倍率超出 0.1–10，请调整比例。");
      }
    }
    return { leaves, center, rounded };
  }

  async function setNode(item, restore = false, renderer) {
    const { node, kind } = item;
    if (kind === "text") {
      // 使用自动模式更新字号，避开手动 resizeHandle 的 75px 截断及逐节点推开邻居。
      await set(node, "sizeAdjust", "auto");
      try {
        await node.setFontScaleLevel(restore ? item.level : item.nextLevel);
        if (!restore) {
          const target = item.after;
          const center = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
          const nativeRect = await rect(node);
          if (item.mode === "auto") {
            target.w = nativeRect.w;
            target.h = nativeRect.h;
          } else {
            const font = await node.getFontSize();
            const padding = await node.getPadding();
            const measured = await renderer.measureMultiLineTextSize(item.text, font, target.w - padding * 2, 1.5);
            target.h = (await measured.y) + padding * 2;
          }
          // 使用与保存重开一致的原生尺寸，维持节点中心的等比布局。
          target.x = center.x - target.w / 2;
          target.y = center.y - target.h / 2;
        }
      } finally {
        await set(node, "sizeAdjust", item.mode);
      }
    } else if (kind === "latex") {
      await set(node, "fontScaleLevel", restore ? item.level : item.nextLevel);
    } else if (item.scale !== undefined) {
      await set(node, "scale", restore ? item.scale : item.nextScale);
    }
    await set(node, "collisionBox", box(restore ? item.before : item.after));
  }

  async function scaleSelection(fixedFactor) {
    const project = await prg.tabs_getCurrentProject();
    if (!project) throw new Error("请先打开一个工程。");
    const projectId = await identity(project);
    const collaboration = await project.collaboration;
    if (collaboration && await collaboration.isActive && !(await collaboration.canEdit)) throw new Error("当前工程为只读权限，无法缩放。");
    const manager = await project.stageManager;
    const selected = await selectionIds(manager);
    if (!selected.length) throw new Error("请先框选要一起缩放的节点。");
    let factor = fixedFactor;
    if (factor === undefined) {
      const previous = await prg.settings_getOwn("lastPercent");
      const input = await prg.dialog_input("选区等比缩放", "相对于当前大小：50 = 缩小一半，200 = 放大一倍。节点围绕选区中心缩放。", { defaultValue: String(previous ?? 50) });
      if (input === undefined || input === null) return;
      factor = percent(input);
    }
    if (factor === 1) return;
    const current = await prg.tabs_getCurrentProject();
    if (!current || await identity(current) !== projectId) throw new Error("当前工程已切换，请重新选择节点。");
    const currentSelection = await selectionIds(manager);
    if (currentSelection.length !== selected.length || currentSelection.some((id) => !selected.includes(id))) throw new Error("选区已改变，请重新执行缩放。");
    const selectedItems = await collect(manager, selected);
    const items = [];
    for (const item of selectedItems.values()) items.push(await snapshot(item));
    const { leaves, rounded } = plan(items, factor);
    for (const item of leaves) if (item.scale !== undefined) item.nextScale = item.scale * factor;
    const arcs = [];
    for (const edge of await manager.getArcEdges()) {
      const source = await (await edge.source).uuid;
      const target = await (await edge.target).uuid;
      if (selectedItems.has(source) && selectedItems.has(target)) arcs.push({ edge, before: await edge.offset });
    }
    // 旧版实验性 CR 曲线未使用当前持久化协议，禁止做无法可靠撤销的变更。
    for (const edge of await manager.getCrEdges()) {
      if (selectedItems.has(await (await edge.source).uuid) || selectedItems.has(await (await edge.target).uuid)) {
        throw new Error("选区连接了旧版实验性 CR 曲线，暂不支持可靠保存与撤销。请先改用普通连线或圆弧。");
      }
    }
    const history = await project.historyManager;
    const renderer = await project.textRenderer;
    async function assertCurrent() {
      const active = await prg.tabs_getCurrentProject();
      if (!active || await identity(active) !== projectId) throw new Error("缩放期间切换了工程，已停止操作。");
    }
    await assertCurrent();
    await history.recordStep();
    const applied = [];
    const changedArcs = [];
    try {
      for (const item of leaves) {
        await assertCurrent();
        applied.push(item);
        await setNode(item, false, renderer);
      }
      for (const arc of arcs) {
        changedArcs.push(arc);
        await set(arc.edge, "offset", arc.before * factor);
      }
      await manager.updateReferences();
      await history.recordStep();
    } catch (error) {
      const failures = [];
      for (const item of applied.reverse()) {
        try { await setNode(item, true); } catch (failure) { failures.push(errorText(failure)); }
      }
      for (const arc of changedArcs) {
        try { await set(arc.edge, "offset", arc.before); } catch (failure) { failures.push(errorText(failure)); }
      }
      try { await manager.updateReferences(); } catch (failure) { failures.push(errorText(failure)); }
      if (failures.length) throw new Error(`缩放失败：${errorText(error)}；部分恢复失败，请使用撤销。${failures.join("；")}`);
      throw new Error(`缩放失败，已恢复原布局：${errorText(error)}`);
    }
    if (fixedFactor === undefined) await prg.settings_setOwn("lastPercent", factor * 100);
    await prg.toast_success(`已将 ${leaves.length} 个节点缩放为 ${Number((factor * 100).toFixed(4))}%，可撤销。${rounded ? "部分字号由原生程序取整。" : ""}`);
  }

  async function run(factor) {
    if (running) return;
    running = true;
    try { await scaleSelection(factor); }
    catch (error) { await prg.toast_error(`选区等比缩放：${errorText(error)}`); }
    finally { running = false; }
  }
  await prg.keybinds_register("输入缩放比例", { $lucide: "Scaling" }, "k s s", Comlink.proxy(() => run()));
  await prg.keybinds_register("缩小至一半", { $lucide: "Shrink" }, "k s -", Comlink.proxy(() => run(0.5)));
  await prg.keybinds_register("放大至两倍", { $lucide: "Expand" }, "k s =", Comlink.proxy(() => run(2)));
})().catch(async (error) => {
  await prg.toast_error(`选区等比缩放扩展无法启动：${error instanceof Error ? error.message : String(error)}`);
});
