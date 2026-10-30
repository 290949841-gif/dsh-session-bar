window.__ModuleLoader__.load({
  id: "dsh-session-bar",
  factory: () => {
    // ── 这个插件在补什么 ────────────────────────────────────────────────────
    // 官方的"已完成"绿点由 @deepseek-ai/dsh-client-ui-session 决定：
    //   observeRunning(id, running) 里只有 !isMain(id) 才 completionUnread.add(id)
    //   （isMain = retainedBy.mainView > 0，即"你正在看的那个会话"）
    // 所以：你正看着的会话跑完，侧栏永远是空的。这个插件不改官方逻辑，只在
    // "运行中 → 不再运行"的那一刻把那一行**永久标成橙色**，直到你点开它才撤销。
    //
    // 运行中的那一行则显示**半透明绿色进度条**：左边一截绿色随估算时间推进。
    // 侧栏行数据里只有 updatedAt（没有开始时间/步数），所以进度只能本地估：
    // 插件自己记录每次 running 持续的时长，按标题存 localStorage，取中位数当
    // "这类任务通常要多久"；没有历史就用全局中位数，再没有就按 90 秒。
    // 进度 = 已用时长 / 预期时长，线性映射到 0~95%，超时后缓慢爬向 99%。
    //
    // ── 为什么要猜 DOM ──────────────────────────────────────────────────────
    // 侧栏会话行现在由 dsh-session-keeper 接管渲染（它 fork 了 ui-workspace 的行，
    // 而且 0 处 renderSlot，官方那套 sidebar.session.row.leading 插槽对它无效）。
    // 两种渲染器都照顾：
    //   官方   ui-workspace : div[data-row-key="session:<id>"]
    //   keeper              : div[role="treeitem"][class*="_sessionRow"]
    // 行内元素：<span class="…_slot">（前置位/状态点）<span class="…_title">标题
    //          <span class="…_time">相对时间 <span class="…_rowActions">菜单
    // 状态点锚点稳定：StateDot 输出 data-state="ongoing|done|idle|error|warning"，
    // 运行中是 <svg data-state="ongoing">（那个转圈的空心圆），空闲时状态点根本不渲染。
    //
    // ── 为什么用标题当 key ───────────────────────────────────────────────────
    // keeper 的行 DOM 上没有任何会话 id 属性，能拿到的稳定身份只有标题文本。
    // 用标题存进 localStorage（跨重载保留"未读完成"和时长样本），点开即清。
    const ROW = [
      'div[data-row-key^="session:"]',
      'div[role="treeitem"][class*="_sessionRow"]',
    ].join(",");
    const MARK = "data-done-mark";
    const DOT = "data-done-dot";
    const RUN = "data-running-mark";
    const STORE_KEY = "dsh-session-bar:read";
    const DUR_KEY = "dsh-session-bar:durations";
    const RUN_KEY = "dsh-session-bar:running";
    const ORANGE = "#fb923c";
    const GREEN = "52 211 153";
    const DEFAULT_MS = 180000;
    const MAX_SAMPLES = 6;
    const MAX_GLOBAL = 24;

    const CSS = `
/* 任务跑完的会话行：左侧橙色竖条 + 橙色底光（永久保留，点开才清） */
[${MARK}]{
  box-shadow:inset 2px 0 0 0 ${ORANGE}, inset 0 0 0 1px rgb(251 146 60 / .32)!important;
  background-color:rgb(251 146 60 / .12)!important;
  animation:dsh-done-mark-in .28s ease-out;
}
[${MARK}] [class*="_title"]{
  color:#fdba74!important;
}
/* 标题前的橙色小圆点：只留纯色，不发光 */
[${DOT}]{
  width:6px;
  height:6px;
  flex:none;
  border-radius:50%;
  background:${ORANGE};
  align-self:center;
  animation:dsh-done-dot-in .28s ease-out;
}
/* 运行中的会话行：绿色卡片 + 底部一条光带进度条。
   光带按估算百分比加长、末端一颗带光晕的小圆点跟着走；
   全程静态——不做条纹流动、不扫光、不呼吸，只有长度在变。 */
[${RUN}]{
  position:relative;
  overflow:hidden;
  /* 给底部这条留出 6px 的地儿，标题和进度条互不压 */
  box-sizing:border-box!important;
  padding-bottom:6px!important;
  background-color:rgb(${GREEN} / .065)!important;
  /* 轨道 */
  background-image:linear-gradient(rgb(${GREEN} / .09), rgb(${GREEN} / .09))!important;
  background-repeat:no-repeat!important;
  background-position:5px calc(100% - 6px)!important;
  background-size:calc(100% - 10px) 6px!important;
  box-shadow:inset 0 0 0 1px rgb(${GREEN} / .20)!important;
}
/* 进度条本体：6px 高、两端圆头 */
[${RUN}]::after{
  content:"";
  position:absolute;
  left:5px;
  bottom:0;
  height:6px;
  width:max(0px, calc(var(--dsh-run-progress,0%) - 5px));
  border-radius:3px;
  /* 三层：两层静止的白色小点 + 一层底色渐变；小点铺在条身上，不闪不滚 */
  background-image:
    radial-gradient(circle at 4px 2px, rgb(255 255 255 / .85) 1px, rgb(255 255 255 / 0) 1.7px),
    radial-gradient(circle at 13px 4px, rgb(255 255 255 / .55) .8px, rgb(255 255 255 / 0) 1.4px),
    linear-gradient(90deg, #5eead4, #67e8f9 60%, #a5f3fc);
  background-size:19px 6px, 27px 6px, 100% 100%;
  background-repeat:repeat-x, repeat-x, no-repeat;
  animation:dsh-run-dots 3.2s linear infinite;
  box-shadow:0 0 5px rgb(${GREEN} / .30);
  transition:width .45s linear;
  pointer-events:none;
}
/* 末端那颗白色圆钮：高度跟条一致，圆心落在条的末端上 */
[${RUN}]::before{
  content:"";
  position:absolute;
  bottom:0;
  left:clamp(0px, calc(var(--dsh-run-progress,0%) - 3px), calc(100% - 6px));
  width:6px;
  height:6px;
  border-radius:50%;
  background:#f0fdfa;
  box-shadow:0 0 5px rgb(${GREEN} / .55);
  transition:left .45s linear;
  pointer-events:none;
}
[${RUN}] [class*="_title"]{
  color:#e3fbf3!important;
}
/* 行首那块 16px 的空位整个让出来：官方转圈藏掉，百分比/计时直接钉在最左边，
   这样不管这一行是从官方组件还是 keeper 的 fork 渲染的，位置都一样。 */
[${RUN}] [class*="_slot"]{
  display:none!important;
}
[${RUN}] [data-state="ongoing"]{
  display:none!important;
}
@keyframes dsh-run-dots{
  from{background-position:0 0, 0 0, 0 0}
  to{background-position:19px 0, 27px 0, 0 0}
}
@keyframes dsh-done-mark-in{
  from{background-color:rgb(251 146 60 / .34)}
  to{background-color:rgb(251 146 60 / .12)}
}
@keyframes dsh-done-dot-in{
  from{transform:scale(.2);opacity:0}
  to{transform:scale(1);opacity:1}
}
/* 行首那个"大概跑到多少了"的百分比数字，占的正是圆点/转圈那块位置 */
[data-run-percent]{
  font-variant-numeric:tabular-nums;
  color:#6ee7b7;
  font-size:10px;
  line-height:20px;
  white-space:nowrap;
  flex:none;
}
@media (prefers-reduced-motion:reduce){
  [${MARK}],[${DOT}]{animation:none}
  [${RUN}]::after{animation:none}
  [${RUN}]::before,[${RUN}]::after{transition:none}
}
`;

    const inject = () => {
      try {
        if (document.querySelector('style[data-plugin="dsh-session-bar"]') !== null) return;
        const style = document.createElement("style");
        style.dataset.plugin = "dsh-session-bar";
        style.textContent = CSS;
        document.head.appendChild(style);
      } catch (_) {}
    };

    const readJson = (key, fallback) => {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return fallback;
        const value = JSON.parse(raw);
        return value ?? fallback;
      } catch (_) {
        return fallback;
      }
    };
    const writeJson = (key, value) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (_) {}
    };

    // ── 已阅标记（橙色） ─────────────────────────────────────────────────────
    const markedRaw = readJson(STORE_KEY, []);
    const marked = new Set(
      Array.isArray(markedRaw) ? markedRaw.filter((v) => typeof v === "string") : [],
    );
    const saveMarked = () => writeJson(STORE_KEY, [...marked]);

    // 每次"变橙"都记一条：谁、什么时候、这一轮跑了多久。出问题能回溯。
    const LOG_KEY = `${STORE_KEY}:log`;
    const logMark = (title, ms) => {
      const list = readJson(LOG_KEY, []);
      const next = (Array.isArray(list) ? list : []).concat([{ t: Date.now(), title, ms }]);
      writeJson(LOG_KEY, next.slice(-60));
    };

    // 存储结构版本。升级时清空一次标记表，避免老版本误标的行一直赖着。
    const SCHEMA_KEY = `${STORE_KEY}:schema`;
    const SCHEMA = 2;
    if (readJson(SCHEMA_KEY, 0) !== SCHEMA) {
      marked.clear();
      writeJson(SCHEMA_KEY, SCHEMA);
      saveMarked();
    }

    // ── 时长样本（绿色进度条的估算依据） ─────────────────────────────────────
    const durRaw = readJson(DUR_KEY, {});
    const durations = {};
    if (durRaw !== null && typeof durRaw === "object" && !Array.isArray(durRaw)) {
      for (const [k, v] of Object.entries(durRaw)) {
        if (Array.isArray(v)) {
          const nums = v.filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
          if (nums.length !== 0) durations[k] = nums.slice(-MAX_SAMPLES);
        }
      }
    }
    const globalRaw = readJson(`${DUR_KEY}:global`, []);
    const globalDurations = (Array.isArray(globalRaw) ? globalRaw : [])
      .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
      .slice(-MAX_GLOBAL);
    const saveDurations = () => {
      writeJson(DUR_KEY, durations);
      writeJson(`${DUR_KEY}:global`, globalDurations);
    };

    // ── 谁在跑、从什么时候开始跑 ─────────────────────────────────────────────
    // 用标题做 key 持久化，元素被 React 重建也不会丢计时。
    const runRaw = readJson(RUN_KEY, {});
    const runs = new Map();
    if (runRaw !== null && typeof runRaw === "object" && !Array.isArray(runRaw)) {
      for (const [k, v] of Object.entries(runRaw)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) runs.set(k, v);
      }
    }
    const saveRuns = () => writeJson(RUN_KEY, Object.fromEntries(runs));

    const median = (list) => {
      const sorted = [...list].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    // 这个标题以前一般跑多久？→ 没有就借全局中位数 → 再没有就 90 秒。
    const expectedFor = (key) => {
      const own = durations[key];
      if (own !== undefined && own.length !== 0) return median(own);
      if (globalDurations.length >= 2) return median(globalDurations);
      return DEFAULT_MS;
    };
    // 按 0.75 次幂推到 95%（开头走快一点，看着不那么"卡住"），
    // 超时后按每 4 倍预算再爬 4 个点，最多 99%。
    const percentFor = (elapsed, expected) => {
      const budget = Math.max(5000, expected);
      if (elapsed <= budget) return Math.max(1, Math.pow(elapsed / budget, 0.75) * 95);
      const over = (elapsed - budget) / (budget * 4);
      return Math.min(99, 95 + over * 4);
    };
    const recordDuration = (key, ms) => {
      if (!(ms >= 2000 && ms <= 2 * 60 * 60 * 1000)) return; // 太短/太长都不算样本
      const own = durations[key] ?? [];
      own.push(ms);
      durations[key] = own.slice(-MAX_SAMPLES);
      globalDurations.push(ms);
      if (globalDurations.length > MAX_GLOBAL) {
        globalDurations.splice(0, globalDurations.length - MAX_GLOBAL);
      }
      saveDurations();
    };

    // 会被自动改名的占位标题：这类"标题变化"是同一个会话，其余一律当元素复用。
    const PLACEHOLDER = /^(新会话|新对话|新聊天|空会话|New chat|New session|New conversation|Untitled)$/i;
    const isPlaceholderTitle = (title) => title === "" || PLACEHOLDER.test(title);

    const previous = new WeakMap();
    // 这一轮"我们亲眼看到它开始跑"的时刻，用来卡掉一闪而过的假 running。
    const runSinceEl = new WeakMap();
    const MIN_RUN_MS = 2000;
    const elementKey = new WeakMap();
    const isRunning = (row) => row.querySelector('[data-state="ongoing"]') !== null;
    const titleOf = (row) => {
      const title = row.querySelector('[class*="_title"]');
      return title === null ? "" : (title.textContent ?? "").trim();
    };

    // 橙色小圆点要塞在行首那块空白里（官方状态点占的 16px slot，居中），
    // 这样标题位置完全不动。slot 不存在（flat 行）时退一步当成行内第一个元素，
    // 总之永远贴着行最左边，不挤在标题前面。
    const ensureDot = (row) => {
      if (row.querySelector(`[${DOT}]`) !== null) return;
      try {
        const dot = document.createElement("span");
        dot.setAttribute(DOT, "1");
        dot.setAttribute("aria-hidden", "true");
        const slot = row.querySelector('[class*="_slot"]');
        if (slot !== null && slot.childElementCount === 0) slot.appendChild(dot);
        else row.prepend(dot);
      } catch (_) {}
    };

    const mark = (row) => {
      row.setAttribute(MARK, "1");
      ensureDot(row);
    };

    const unmark = (row) => {
      if (row.hasAttribute(MARK)) row.removeAttribute(MARK);
      for (const dot of row.querySelectorAll(`[${DOT}]`)) dot.remove();
    };

    const forget = (key) => {
      if (marked.delete(key)) saveMarked();
    };

    // 运行中：给行打上标记、把进度写进 CSS 变量，并把百分比放到行首那块空位上。
    // 一旦跑过预估时长，就不再硬撑一个假的百分比了，改成显示真实已用时间（如 3:12）。
    const paintRunning = (row, key) => {
      const started = runs.get(key);
      if (started === undefined) return;
      const elapsed = Date.now() - started;
      const expected = expectedFor(key);
      const percent = percentFor(elapsed, expected);
      const overtime = elapsed > Math.max(5000, expected);
      if (!row.hasAttribute(RUN)) row.setAttribute(RUN, "1");
      const next = `${percent.toFixed(1)}%`;
      if (row.style.getPropertyValue("--dsh-run-progress") !== next) {
        row.style.setProperty("--dsh-run-progress", next);
      }
      let badge = row.querySelector("[data-run-percent]");
      if (badge === null || row.firstElementChild !== badge) {
        try {
          if (badge === null) {
            badge = document.createElement("span");
            badge.setAttribute("data-run-percent", "1");
          }
          // 永远钉在行首第一个子节点：不依赖 slot 存不存在、结构怎么变。
          row.prepend(badge);
        } catch (_) {
          badge = null;
        }
      }
      if (badge !== null) {
        const totalSeconds = Math.floor(elapsed / 1000);
        const text = overtime
          ? `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`
          : `${Math.round(percent)}%`;
        if (badge.textContent !== text) {
          badge.textContent = text;
        }
      }
    };

    const clearRunning = (row) => {
      if (row.hasAttribute(RUN)) row.removeAttribute(RUN);
      if (row.style.getPropertyValue("--dsh-run-progress") !== "") {
        row.style.removeProperty("--dsh-run-progress");
      }
      const badge = row.querySelector("[data-run-percent]");
      if (badge !== null) badge.remove();
    };

    const scan = () => {
      const now = Date.now();
      for (const row of document.querySelectorAll(ROW)) {
        const key = titleOf(row);
        if (key === "") continue;
        // 一行的标题变了，可能有两种完全不同的原因：
        //   a) 会话跑完一轮后被自动命名：「新会话」→ 真标题（同一个会话）
        //   b) React 把同一个 DOM 元素复用给了列表里的另一条会话（排序一变就会发生）
        // 只有 (a) 该继承计时和标记；(b) 必须把元素上的一切清干净，否则标记会
        // 顺着被复用的元素爬到毫不相干的会话上——侧栏"全亮"就是这么来的。
        const lastKey = elementKey.get(row);
        elementKey.set(row, key);
        if (lastKey !== undefined && lastKey !== key) {
          if (isPlaceholderTitle(lastKey)) {
            if (runs.has(lastKey)) {
              runs.set(key, runs.get(lastKey));
              runs.delete(lastKey);
              saveRuns();
            }
            if (marked.has(lastKey) && !marked.has(key)) {
              marked.delete(lastKey);
              marked.add(key);
              saveMarked();
            }
          } else {
            previous.delete(row);
            runSinceEl.delete(row);
            if (row.hasAttribute(MARK) && !marked.has(key)) unmark(row);
          }
        }

        const running = isRunning(row);
        const was = previous.get(row);
        previous.set(row, running);

        if (running) {
          // 又跑起来了：上一轮的"完成"标记作废，改画进度条
          forget(key);
          unmark(row);
          if (!runs.has(key)) {
            runs.set(key, now);
            saveRuns();
          }
          if (!runSinceEl.has(row)) runSinceEl.set(row, now);
          paintRunning(row, key);
          continue;
        }

        clearRunning(row);
        const runStarted = runSinceEl.get(row);
        runSinceEl.delete(row);
        if (runs.has(key)) {
          recordDuration(key, now - runs.get(key));
          runs.delete(key);
          saveRuns();
        }
        // 只有"亲眼看到它跑够 MIN_RUN_MS"才算完成。启动瞬间的状态抖动、
        // 恢复会话时的短暂 running 都不会再把整列点成橙色。
        const ranFor = runStarted === undefined ? 0 : now - runStarted;
        if (was === true && ranFor >= MIN_RUN_MS) {
          marked.add(key);
          saveMarked();
          logMark(key, ranFor);
          mark(row);
        }
        // 以「标记表」为准重画，而不是以行为准：行上的残留属性可能来自被复用的元素。
        if (marked.has(key)) mark(row);
        else if (row.querySelector(`[${DOT}]`) !== null) unmark(row);
      }
    };

    const schedule = (() => {
      let queued = false;
      return () => {
        if (queued) return;
        queued = true;
        const run = () => {
          queued = false;
          scan();
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
        else window.setTimeout(run, 60);
      };
    })();

    // 点开某一行 = 已阅：撤掉橙色，并把它从持久化表里删掉。
    // 行尾的那个「…」菜单按钮不算点开，点它不该清标记。
    const onPointerDown = (event) => {
      try {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("button, [class*='_rowActions']") !== null) return;
        const row = target.closest(ROW);
        if (row === null) return;
        const key = titleOf(row);
        if (key === "") return;
        if (marked.has(key)) {
          forget(key);
          unmark(row);
        }
      } catch (_) {}
    };

    const start = () => {
      inject();
      // 排障入口：出问题时可在控制台里查"谁被标了、什么时候标的、跑了多久"。
      try {
        window.dshSessionBar = {
          marks: () => [...marked],
          log: () => readJson(LOG_KEY, []),
          clearMarks() {
            marked.clear();
            saveMarked();
            for (const row of document.querySelectorAll(ROW)) unmark(row);
          },
        };
      } catch (_) {}
      const root = document.body ?? document.documentElement;
      if (root === null) return () => {};
      // React 重渲染可能把我们插的属性/圆点/百分比冲掉，所以除了监听变动，
      // 再用 500ms 的低频扫描兜底（同时负责把进度条往前推）。
      const observer = new MutationObserver(() => schedule());
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-state"],
      });
      const timer = window.setInterval(scan, 500);
      document.addEventListener("pointerdown", onPointerDown, true);
      schedule();
      return () => {
        observer.disconnect();
        clearInterval(timer);
        document.removeEventListener("pointerdown", onPointerDown, true);
      };
    };

    let stop = null;
    return {
      name: "dsh-session-bar",
      apply() {
        try {
          stop = start();
        } catch (_) {}
      },
      dispose() {
        try {
          if (typeof stop === "function") stop();
        } catch (_) {}
        stop = null;
      },
    };
  },
});
